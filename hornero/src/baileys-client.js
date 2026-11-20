import EventEmitter2 from "eventemitter2";
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
} from "baileys";
import PQueue from "p-queue";
import pino from "pino";
import { MessageStore } from "./message-store.js";
import { findMedia, identityOf, mediaInfo, phoneOf } from "./inbound.js";
import { decryptVote, pollCreationOf } from "./polls.js";

/** Message types accepted by the `type` discriminator of incoming events. */
export const MessageType = {
  text: "conversation",
  location: "locationMessage",
  liveLocation: "liveLocationMessage",
  image: "imageMessage",
  video: "videoMessage",
  document: "documentMessage",
  contact: "contactMessage",
};

const SUFFIXES = ["@s.whatsapp.net", "@g.us", "@broadcast", "@lid"];

/** Disconnect reasons that must reconnect immediately, without backoff. */
const IMMEDIATE_RECONNECT = new Set([
  DisconnectReason.restartRequired, // 515: handshake asks for a fresh socket
]);

const ERROR_MESSAGES = {
  401: "Logged Out",
  403: "Forbidden",
  408: "Connection Lost",
  411: "Multidevice Mismatch",
  428: "Connection Closed",
  440: "Connection Replaced",
  500: "Bad Session",
  503: "Unavailable Service",
  515: "Restart Required",
};

export class NumberNotFoundError extends Error {
  constructor(phone = "") {
    super(`Send message failed. Number ${phone} is not on WhatsApp.`);
    this.name = "NumberNotFoundError";
    this.code = 404;
  }
}

export class DisconnectedError extends Error {
  constructor() {
    super("WhatsApp is not connected. Pair the client from the sidebar panel.");
    this.name = "DisconnectedError";
    this.code = 401;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.code = 404;
  }
}

export class TooLargeError extends Error {
  constructor(bytes, maxBytes) {
    super(
      `The file is ${(bytes / 1e6).toFixed(1)} MB, over the ${(maxBytes / 1e6).toFixed(0)} MB limit.`,
    );
    this.name = "TooLargeError";
    this.code = 413;
  }
}

export class MessagingError extends Error {
  constructor(statusCode, cause) {
    const label = ERROR_MESSAGES[statusCode] || "Unknown Error";
    const detail = cause?.message ? `: ${cause.message}` : "";
    super(`WhatsApp error ${statusCode} (${label})${detail}`);
    this.name = "MessagingError";
    this.code = statusCode;
    this.cause = cause;
  }
}

/** Wraps a Boom/unknown error from Baileys without discarding its message. */
const wrapError = (err) => {
  if (err instanceof MessagingError) return err;
  const statusCode =
    err?.output?.statusCode ?? err?.output?.payload?.statusCode ?? 500;
  return new MessagingError(statusCode, err);
};

/**
 * How long to "type" before sending: longer for longer text, capped, and
 * deliberately variable so consecutive messages are not evenly spaced.
 */
export const typingDelayMs = (text, maxMs, random = Math.random) => {
  if (maxMs <= 0) return 0;
  const typed = Math.min(maxMs, 400 + text.length * 35);
  return Math.round(typed * (0.6 + random() * 0.4));
};

/** Polls are kept far longer than other messages: votes trickle in for days. */
const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a group change is about, from the fields WhatsApp sent. */
const GROUP_CHANGE_ACTIONS = [
  ["subject", "subject"],
  ["desc", "description"],
  ["announce", "announce"],
  ["restrict", "restrict"],
  ["memberAddMode", "member_add_mode"],
  ["joinApprovalMode", "join_approval_mode"],
  ["ephemeralDuration", "ephemeral"],
];

const GROUP_CHANGE_FIELDS = {
  subject: "subject",
  desc: "description",
  announce: "announce",
  restrict: "restrict",
  memberAddMode: "member_add_mode",
  joinApprovalMode: "join_approval_mode",
  ephemeralDuration: "ephemeral_duration",
};

export class BaileysClient extends EventEmitter2 {
  #conn;
  #path;
  #logger;
  #offline;
  #refreshMs;
  #baseDelayMs;
  #maxDelayMs;
  #maxAttempts;
  #settings;

  #refreshInterval;
  #presenceInterval;
  #saveCreds;
  #creds;
  #version;
  #queue = new PQueue({ concurrency: 1 });
  #existsCache = new Map();
  #contacts = new Map();
  #avatarCache = new Map();
  #groupNames = new Map();
  #avatarTtlMs = 60 * 60 * 1000;
  #existsTtlMs = 10 * 60 * 1000;
  #pushNames = new Map();
  #store;
  #storeLoaded = false;
  #stopped = false;
  #lastQr = null;

  #status = {
    attempt: 0,
    connected: false,
    disconnected: false,
    reconnecting: false,
    phone: null,
    name: null,
    lastConnectedAt: null,
    lastDisconnectReason: null,
  };

  constructor({
    path,
    logger,
    offline = true,
    // 0 disables the periodic restart. It was a Baileys 6 workaround; Baileys 7
    // keeps the socket alive on its own, so it is off unless explicitly enabled.
    refreshMs = 0,
    baseDelayMs = 1000,
    maxDelayMs = 5 * 60 * 1000,
    maxAttempts = Infinity,
    settings,
  }) {
    super();
    this.#path = path;
    this.#logger = logger ?? pino({ level: "silent" });
    this.#offline = offline;
    this.#refreshMs = refreshMs;
    this.#baseDelayMs = baseDelayMs;
    this.#maxDelayMs = maxDelayMs;
    this.#maxAttempts = maxAttempts;
    this.#settings = settings;
    this.#store = new MessageStore({ dir: path, logger: this.#logger });
  }

  /** Public, read-only view of the connection state. */
  get status() {
    return { ...this.#status };
  }

  get qr() {
    return this.#lastQr;
  }

  /**
   * Both forms of this account's own identity, phone and LID. A group may
   * address it either way, so mention matching needs both.
   */
  get ownJids() {
    const user = this.#conn?.user;
    const me = this.#creds?.me;
    return [...new Set([user?.id, user?.lid, me?.id, me?.lid].filter(Boolean))];
  }

  /** Opens the socket. Must be awaited by the caller so failures surface. */
  async start() {
    this.#stopped = false;
    if (!this.#storeLoaded) {
      this.#storeLoaded = true;
      await this.#store.load();
    }
    await this.#connect();
  }

  /** Permanently stops the client; no reconnection will be attempted. */
  async stop() {
    this.#stopped = true;
    this.#status.disconnected = true;
    this.#status.reconnecting = false;
    clearInterval(this.#refreshInterval);
    clearInterval(this.#presenceInterval);
    try {
      this.#conn?.end(undefined);
    } catch {
      // the socket may already be closed
    }
    await this.#store.save();
  }

  restart() {
    this.emit("restart");
    this.#status.connected = false;
    this.#status.reconnecting = true;
    return this.#conn?.end(undefined);
  }

  async #connect() {
    if (this.#status.connected || this.#stopped) return;

    const version = await this.#resolveVersion();
    const { state, saveCreds } = await useMultiFileAuthState(this.#path);
    this.#saveCreds = saveCreds;
    this.#creds = state.creds;

    this.#conn = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.#logger),
      },
      logger: this.#logger,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: !this.#offline,
      generateHighQualityLinkPreview: true,
      // Recent messages are kept, so a retry for one of them can be served.
      getMessage: async (key) => this.#store.get(key?.id)?.message ?? undefined,
    });

    this.#conn.ev.on("creds.update", async () => {
      await this.#saveCreds();
      if (state.creds.me) {
        this.#status.phone = state.creds.me.id.split(":")[0];
        this.#status.name = state.creds.me.name ?? null;
        this.emit("pair", {
          phone: this.#status.phone,
          name: this.#status.name,
        });
      }
    });

    this.#conn.ev.on("connection.update", this.#onConnectionUpdate);
    this.#conn.ev.on("messages.upsert", this.#onMessagesUpsert);
    this.#conn.ev.on("messages.update", this.#onMessagesUpdate);
    this.#conn.ev.on("contacts.upsert", this.#onContacts);
    this.#conn.ev.on("contacts.update", this.#onContacts);
    this.#conn.ev.on("messaging-history.set", ({ contacts }) =>
      this.#onContacts(contacts ?? []),
    );
    this.#conn.ev.on("presence.update", (presence) =>
      this.emit("presence_update", presence),
    );
    this.#conn.ev.on("messages.reaction", this.#onReactions);
    this.#conn.ev.on("group-participants.update", this.#onParticipants);
    this.#conn.ev.on("groups.update", this.#onGroupsUpdate);
  }

  /**
   * Resolves the WhatsApp Web version to announce. Advertising a stale one
   * makes WhatsApp flag outgoing messages as sent from an old client, so the
   * live version published by web.whatsapp.com wins. The number pinned in the
   * Baileys repository (which lags behind) is the first fallback, then the
   * last known version, then Baileys' bundled default. A network hiccup can
   * never break a reconnection. Runs on every (re)connect, so the periodic
   * refresh also picks up new WhatsApp Web releases.
   */
  async #resolveVersion() {
    const sources = [
      ["web.whatsapp.com", fetchLatestWaWebVersion],
      ["Baileys repository", fetchLatestBaileysVersion],
    ];
    for (const [source, fetchVersion] of sources) {
      try {
        const { version, isLatest, error } = await fetchVersion({});
        if (!isLatest || !Array.isArray(version)) {
          throw error ?? new Error("no version returned");
        }
        if (this.#version?.join(".") !== version.join(".")) {
          this.#logger.info(
            { version: version.join("."), source },
            "using WhatsApp Web version",
          );
        }
        this.#version = version;
        return version;
      } catch (err) {
        this.#logger.warn(
          { err: err?.message ?? String(err), source },
          "could not fetch WhatsApp Web version",
        );
      }
    }
    return this.#version;
  }

  #onConnectionUpdate = (event) => {
    if (event.qr) {
      this.#lastQr = event.qr;
      this.emit("qr", event.qr);
    }
    if (event.connection === "open") this.#onConnected();
    else if (event.connection === "close") this.#onDisconnected(event);
  };

  #onConnected = () => {
    this.#status.attempt = 0;
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;
    this.#status.lastConnectedAt = new Date().toISOString();
    this.#status.lastDisconnectReason = null;
    this.#lastQr = null;

    clearInterval(this.#refreshInterval);
    if (this.#refreshMs > 0) {
      this.#refreshInterval = setInterval(
        () => this.restart(),
        this.#refreshMs,
      );
    }
    if (this.#offline) this.setSendPresenceUpdateInterval("unavailable");

    this.emit("ready");
  };

  #onDisconnected = ({ lastDisconnect }) => {
    this.#status.connected = false;
    clearInterval(this.#refreshInterval);
    this.setSendPresenceUpdateInterval();

    const statusCode =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.output?.payload?.statusCode;
    this.#status.lastDisconnectReason = statusCode ?? null;

    if (statusCode === DisconnectReason.loggedOut) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      this.emit("logout");
      return;
    }

    this.emit("disconnected", statusCode);
    this.#reconnect(statusCode);
  };

  #onMessagesUpsert = ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key?.fromMe) continue;
      this.#recordPushName(msg);
      if (msg.message.pollUpdateMessage) {
        this.#onPollVote(msg).catch((err) =>
          this.#logger.warn({ err: err.message }, "could not read a poll vote"),
        );
      }
      delete msg.message.messageContextInfo;
      const [type] = Object.keys(msg.message);
      this.emit("msg", { type, ...msg });
    }
  };

  /** The name each sender goes by, under every form of their id. */
  #recordPushName(msg) {
    if (!msg.pushName) return;
    const key = msg.key ?? {};
    const ids = key.participant
      ? [key.participant, key.participantAlt]
      : [key.remoteJid, key.remoteJidAlt];
    for (const jid of ids) {
      if (jid) this.#pushNames.set(identityOf(jid).jid, msg.pushName);
    }
  }

  /**
   * Fills in whichever form of an identity is missing — the phone number
   * behind a LID, or the LID of a number — from the mapping WhatsApp shares.
   */
  async resolveIdentity(...jids) {
    const identity = identityOf(...jids);
    const mapping = this.#conn?.signalRepository?.lidMapping;
    try {
      if (identity.lid && !identity.phone && mapping) {
        const pn = await mapping.getPNForLID(identity.lid);
        if (pn) Object.assign(identity, identityOf(pn, identity.lid));
      } else if (identity.phone && !identity.lid && mapping) {
        const lid = await mapping.getLIDForPN(identity.jid);
        if (lid) identity.lid = identityOf(lid).lid;
      }
    } catch {
      // the mapping is best-effort; the ids WhatsApp sent still stand
    }
    return identity;
  }

  #nameOf(identity) {
    for (const jid of [identity.jid, identity.lid]) {
      if (!jid) continue;
      const name =
        this.#pushNames.get(jid) ?? this.#contacts.get(jid)?.name ?? null;
      if (name) return name;
    }
    return null;
  }

  /**
   * A reaction to any message in a chat. Reactions this account makes are
   * left out. `from_me` tells whether the message reacted to was ours.
   */
  #onReactions = async (reactions) => {
    for (const { key, reaction } of reactions ?? []) {
      const by = reaction?.key ?? {};
      if (by.fromMe || !key?.id) continue;
      try {
        const author = await this.resolveIdentity(
          ...(by.participant
            ? [by.participant, by.participantAlt]
            : [by.remoteJid, by.remoteJidAlt]),
        );
        this.emit("reaction", {
          key: by,
          chat: key.remoteJid ?? by.remoteJid,
          author: author.jid,
          author_phone: author.phone,
          author_lid: author.lid,
          push_name: this.#nameOf(author),
          message_id: key.id,
          emoji: reaction.text ?? "",
          removed: !reaction.text,
          from_me: Boolean(key.fromMe),
        });
      } catch (err) {
        this.#logger.warn({ err: err.message }, "could not read a reaction");
      }
    }
  };

  /** A vote on a poll this account sent, decrypted with the poll's secret. */
  async #onPollVote(msg) {
    const update = msg.message.pollUpdateMessage;
    const pollId = update.pollCreationMessageKey?.id;
    const poll = this.#store.get(pollId);
    if (!poll) {
      this.#logger.debug(
        { pollId },
        "poll vote ignored: the poll was not sent from here, or has expired",
      );
      return;
    }

    const selected = decryptVote(msg, poll, { ownJids: this.ownJids });
    if (selected === null) {
      this.#logger.warn({ pollId }, "could not decrypt a poll vote");
      return;
    }

    const key = msg.key ?? {};
    const author = await this.resolveIdentity(
      ...(key.participant
        ? [key.participant, key.participantAlt]
        : [key.remoteJid, key.remoteJidAlt]),
    );
    this.emit("poll_vote", {
      key,
      chat: key.remoteJid,
      author: author.jid,
      author_phone: author.phone,
      author_lid: author.lid,
      push_name: msg.pushName ?? this.#nameOf(author),
      poll_message_id: pollId,
      poll_name: pollCreationOf(poll.message)?.name ?? null,
      selected_options: selected,
    });
  }

  #participantsOf = async (participants) =>
    Promise.all(
      (participants ?? []).map(async (p) => {
        const ids =
          typeof p === "string" ? [p] : [p?.id, p?.phoneNumber, p?.lid];
        const identity = await this.resolveIdentity(...ids);
        return {
          id: identity.jid,
          phone: identity.phone,
          lid: identity.lid,
          admin: (typeof p === "object" && p?.admin) || null,
        };
      }),
    );

  /** Someone joined, left, was removed, promoted or demoted. */
  #onParticipants = async ({ id, author, authorPn, participants, action }) => {
    try {
      const by =
        author || authorPn
          ? await this.resolveIdentity(author, authorPn)
          : null;
      this.emit("group_update", {
        chat: id,
        group_name: this.#groupNames.get(id) ?? null,
        action,
        participants: await this.#participantsOf(participants),
        author: by?.jid ?? null,
        author_phone: by?.phone ?? null,
        author_lid: by?.lid ?? null,
        changes: {},
      });
    } catch (err) {
      this.#logger.warn({ err: err.message }, "could not read a group change");
    }
  };

  /**
   * A group's subject, description or settings changed. Fetching every group
   * makes Baileys emit the same event with the full metadata; that is a
   * refresh, not a change, so it is skipped.
   */
  #onGroupsUpdate = async (updates) => {
    for (const update of updates ?? []) {
      if (!update?.id || "participants" in update || "creation" in update) {
        continue;
      }
      if (typeof update.subject === "string") {
        this.#groupNames.set(update.id, update.subject);
      }

      const changes = {};
      for (const [field, name] of Object.entries(GROUP_CHANGE_FIELDS)) {
        if (update[field] !== undefined) changes[name] = update[field];
      }
      if (Object.keys(changes).length === 0) continue;

      const action =
        GROUP_CHANGE_ACTIONS.find(
          ([field]) => update[field] !== undefined,
        )?.[1] ?? "update";
      try {
        const by =
          update.author || update.authorPn
            ? await this.resolveIdentity(update.author, update.authorPn)
            : null;
        this.emit("group_update", {
          chat: update.id,
          group_name: this.#groupNames.get(update.id) ?? null,
          action,
          participants: [],
          author: by?.jid ?? null,
          author_phone: by?.phone ?? null,
          author_lid: by?.lid ?? null,
          changes,
        });
      } catch (err) {
        this.#logger.warn(
          { err: err.message },
          "could not read a group change",
        );
      }
    }
  };

  #onMessagesUpdate = (updates) => {
    for (const { key, update } of updates) {
      if (update?.status === undefined) continue;
      this.emit("ack", {
        messageId: key?.id,
        to: key?.remoteJid,
        status: update.status,
      });
    }
  };

  /** Exponential backoff with jitter, so a WhatsApp outage is not hammered. */
  #reconnect(statusCode) {
    if (this.#stopped) return;

    if (this.#status.attempt >= this.#maxAttempts) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      this.emit("gave_up");
      return;
    }

    const attempt = this.#status.attempt++;
    this.#status.reconnecting = true;

    const delay = IMMEDIATE_RECONNECT.has(statusCode)
      ? 0
      : Math.min(this.#baseDelayMs * 2 ** attempt, this.#maxDelayMs) *
        (0.5 + Math.random() / 2);

    setTimeout(() => {
      this.#connect().catch((err) =>
        this.#logger.error({ err: err.message }, "reconnection attempt failed"),
      );
    }, delay);
  }

  #assertConnected() {
    if (!this.#status.connected) throw new DisconnectedError();
  }

  /** Normalises a phone number or JID into a WhatsApp JID. */
  toJid(phone) {
    const value = phone?.toString().trim();
    if (!value) throw new Error("Invalid phone");
    if (SUFFIXES.some((suffix) => value.endsWith(suffix))) return value;
    return `${value.replace(/^\+/, "").replace(/\D/g, "")}@s.whatsapp.net`;
  }

  /**
   * Group and broadcast JIDs cannot be resolved by onWhatsApp; for everything
   * else the answer is cached, since the lookup counts towards rate limits.
   */
  async #exists(id) {
    if (
      id.endsWith("@g.us") ||
      id.endsWith("@broadcast") ||
      id.endsWith("@lid")
    ) {
      return true;
    }

    const cached = this.#existsCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.exists;

    const [result] = await this.#conn.onWhatsApp(id);
    const exists = Boolean(result?.exists ?? result);
    this.#existsCache.set(id, {
      exists,
      expiresAt: Date.now() + this.#existsTtlMs,
    });
    return exists;
  }

  /**
   * Baileys 7 dropped its in-memory store, so contacts are accumulated from
   * the events WhatsApp sends after pairing and kept here.
   */
  #onContacts = (contacts) => {
    for (const contact of contacts) {
      if (!contact?.id) continue;
      const previous = this.#contacts.get(contact.id) ?? {};
      const merged = { ...previous, ...contact };
      const name = merged.name || merged.notify || merged.verifiedName;
      if (!name) continue;
      this.#contacts.set(contact.id, { id: contact.id, name });
    }
  };

  /** Contacts known so far, alphabetically. Fills in as WhatsApp syncs. */
  get contacts() {
    return [...this.#contacts.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Groups this account participates in. Group JIDs cannot be derived from a
   * phone number, so this is the only way to address a group.
   */
  async fetchGroups() {
    this.#assertConnected();
    try {
      const groups = await this.#conn.groupFetchAllParticipating();
      for (const group of Object.values(groups)) {
        this.#groupNames.set(group.id, group.subject);
      }
      return Object.values(groups)
        .map((group) => ({
          id: group.id,
          name: group.subject,
          participants: group.participants?.length ?? 0,
          // Every form of each member's identity (LID and phone), so the
          // panel can tell which allowed people are in the group.
          members: (group.participants ?? []).flatMap((p) =>
            [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean),
          ),
          announce: Boolean(group.announce),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      throw wrapError(err);
    }
  }

  /**
   * Profile picture for a chat. WhatsApp rate-limits these, so results are
   * cached — including the "no picture" answer, which is the common case.
   */
  async fetchAvatarUrl(jid) {
    this.#assertConnected();

    const cached = this.#avatarCache.get(jid);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    let url = null;
    try {
      url = (await this.#conn.profilePictureUrl(jid, "preview")) ?? null;
    } catch {
      // 404 from WhatsApp simply means there is no picture set.
      url = null;
    }

    this.#avatarCache.set(jid, {
      url,
      expiresAt: Date.now() + this.#avatarTtlMs,
    });
    return url;
  }

  /**
   * Marks messages as read — the blue ticks, and the chat stops showing as
   * unread on the phone. Takes the `key` objects carried by incoming events.
   */
  async markRead(keys) {
    this.#assertConnected();
    const list = (Array.isArray(keys) ? keys : [keys]).filter(
      (key) => key?.id && key?.remoteJid,
    );
    if (list.length === 0) return 0;

    try {
      await this.#conn.readMessages(list);
      return list.length;
    } catch (err) {
      throw wrapError(err);
    }
  }

  /**
   * A readable name for a chat, from what has already been synced. Returns
   * null rather than guessing, so callers can fall back to the raw id.
   */
  resolveName(jid) {
    return this.#groupNames.get(jid) ?? this.#contacts.get(jid)?.name ?? null;
  }

  async checkNumber(phone) {
    this.#assertConnected();
    const id = this.toJid(phone);
    return { jid: id, exists: await this.#exists(id) };
  }

  /** Requests an 8-digit pairing code as an alternative to scanning the QR. */
  async requestPairingCode(phone) {
    if (this.#status.connected) {
      throw new Error("Client is already paired.");
    }
    if (!this.#conn) {
      throw new DisconnectedError();
    }
    const number = phone.toString().replace(/\D/g, "");
    try {
      return await this.#conn.requestPairingCode(number);
    } catch (err) {
      throw wrapError(err);
    }
  }

  /**
   * Shows the typing (or recording) indicator before a message goes out, and
   * pauses for a spell that varies with the text length.
   *
   * The visible indicator is mostly cosmetic; the part that matters is that
   * consecutive sends stop landing as an instant, evenly spaced burst.
   * Media needs no added pause — the upload already takes a variable while.
   */
  async #announceTyping(id, content) {
    const maxMs = this.#settings?.typingMaxMs ?? 0;
    if (!this.#settings?.get("typingIndicator") || maxMs <= 0) return;

    const text =
      typeof content?.text === "string"
        ? content.text
        : typeof content?.caption === "string"
          ? content.caption
          : "";
    const isAudio = Boolean(content?.audio);
    const isMedia = Boolean(
      content?.image || content?.video || content?.document,
    );

    try {
      await this.#conn.sendPresenceUpdate(
        isAudio ? "recording" : "composing",
        id,
      );
    } catch {
      // A failed indicator must never stop the message itself.
      return;
    }

    if (isMedia) return;

    const delay = typingDelayMs(text, maxMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  sendMessage(phone, content, options, { typing } = {}) {
    return this.#queue.add(async () => {
      this.#assertConnected();
      const id = this.toJid(phone);

      if (!(await this.#exists(id))) {
        throw new NumberNotFoundError(phone);
      }

      if (typing !== false) await this.#announceTyping(id, content);

      try {
        const result = await this.#conn.sendMessage(id, content, options);
        this.#rememberSent(result);
        this.emit("sent", { to: id, content, result });
        return result;
      } catch (err) {
        const failure = wrapError(err);
        this.emit("send_failed", { to: id, content, error: failure.message });
        throw failure;
      } finally {
        // Clear the indicator so it does not linger on the other side.
        this.#conn.sendPresenceUpdate("paused", id).catch(() => {});
      }
    });
  }

  /** How long received messages stay downloadable; 0 keeps none. */
  get #cacheMs() {
    return (this.#settings?.get("mediaCacheHours") ?? 24) * 60 * 60 * 1000;
  }

  /** The largest file download_media and send_media will handle. */
  get maxMediaBytes() {
    return (this.#settings?.get("mediaMaxMb") ?? 20) * 1e6;
  }

  /**
   * Keeps a received message, so its media can be downloaded and it can be
   * reacted to or quoted later by id. Only call it for allowed senders.
   */
  remember(msg) {
    this.#store.put(msg, { ttlMs: this.#cacheMs });
  }

  /** Sent messages are kept too, to edit, delete or count votes on them. */
  #rememberSent(result) {
    if (!result?.key?.id) return;
    if (pollCreationOf(result.message)) {
      this.#store.put(result, { ttlMs: POLL_TTL_MS, kind: "poll" });
    } else {
      this.#store.put(result, { ttlMs: this.#cacheMs });
    }
  }

  /**
   * The full key of a message, from the store when it is known. A key passed
   * in wins; otherwise one is built from the chat, which is enough for
   * messages in a direct chat, but not for someone else's in a group.
   */
  keyFor({ key, chat, messageId, fromMe }) {
    if (key?.id && key?.remoteJid) return key;
    const id = messageId ?? key?.id;
    if (!id) throw new Error("Provide message_id, or a whole key.");

    const stored = this.#store.get(id)?.key;
    if (stored) return stored;

    if (!chat) {
      throw new NotFoundError(
        `Message ${id} is not among the recent ones. Pass the chat too, or the whole key.`,
      );
    }
    return { remoteJid: this.toJid(chat), id, fromMe: Boolean(fromMe) };
  }

  /** Reacts to a message; an empty emoji removes the reaction. */
  react({ key, chat, messageId, emoji }) {
    const target = this.keyFor({ key, chat, messageId });
    return this.sendMessage(
      target.remoteJid,
      { react: { text: emoji ?? "", key: target } },
      undefined,
      { typing: false },
    );
  }

  /** Replaces the text of a message this account sent. */
  editMessage({ key, chat, messageId, text }) {
    const target = this.keyFor({ key, chat, messageId, fromMe: true });
    if (!target.fromMe) {
      throw Object.assign(
        new Error("Only messages sent from here can be edited."),
        {
          code: 400,
        },
      );
    }
    return this.sendMessage(
      target.remoteJid,
      { text, edit: target },
      undefined,
      { typing: false },
    );
  }

  /**
   * Deletes a message for everyone. Anyone may delete their own; a group
   * admin may also delete other members' messages.
   */
  deleteMessage({ key, chat, messageId }) {
    const target = this.keyFor({ key, chat, messageId, fromMe: true });
    return this.sendMessage(target.remoteJid, { delete: target }, undefined, {
      typing: false,
    });
  }

  sendPoll(to, { question, options, selectableCount = 1 }, { typing } = {}) {
    return this.sendMessage(
      to,
      { poll: { name: question, values: options, selectableCount } },
      undefined,
      { typing },
    );
  }

  sendLocation(to, { latitude, longitude, name, address }, { typing } = {}) {
    return this.sendMessage(
      to,
      {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          ...(name ? { name } : {}),
          ...(address ? { address } : {}),
        },
      },
      undefined,
      { typing },
    );
  }

  /**
   * Downloads the file of a recent message. WhatsApp's links expire after a
   * while; when one has, the sender's phone is asked to upload it again.
   */
  async downloadMedia(mediaId) {
    this.#assertConnected();
    let stored = this.#store.get(mediaId);
    if (!stored) {
      throw new NotFoundError(
        `No media ${mediaId} among the recent messages. It may have expired, or come from a sender that is not allowed.`,
      );
    }
    const info = mediaInfo(stored);
    if (!info) throw new NotFoundError(`Message ${mediaId} has no media.`);

    const maxBytes = this.maxMediaBytes;
    if (info.size && info.size > maxBytes) {
      throw new TooLargeError(info.size, maxBytes);
    }

    let buffer;
    try {
      buffer = await downloadMediaMessage(
        stored,
        "buffer",
        {},
        {
          logger: this.#logger,
          reuploadRequest: async (msg) => {
            const updated = await this.#conn.updateMediaMessage(msg);
            stored = updated;
            this.#store.put(updated, { ttlMs: this.#cacheMs });
            return updated;
          },
        },
      );
    } catch (err) {
      throw wrapError(err);
    }

    if (buffer.length > maxBytes)
      throw new TooLargeError(buffer.length, maxBytes);
    return {
      buffer,
      mimetype: info.mimetype ?? "application/octet-stream",
      info: { ...info, size: buffer.length },
      kind: findMedia(stored.message)?.kind ?? info.type,
    };
  }

  /** A group's name, description and members, with both forms of each id. */
  async getGroup(jid) {
    this.#assertConnected();
    const id = this.toJid(jid);
    if (!id.endsWith("@g.us")) {
      throw Object.assign(new Error(`${jid} is not a group id (…@g.us).`), {
        code: 400,
      });
    }
    let meta;
    try {
      meta = await this.#conn.groupMetadata(id);
    } catch (err) {
      throw wrapError(err);
    }
    this.#groupNames.set(meta.id, meta.subject);

    const owner =
      meta.owner || meta.ownerPn
        ? await this.resolveIdentity(meta.owner, meta.ownerPn)
        : null;
    return {
      id: meta.id,
      name: meta.subject ?? null,
      description: meta.desc ?? null,
      owner: owner?.jid ?? null,
      created: meta.creation
        ? new Date(meta.creation * 1000).toISOString()
        : null,
      size: meta.size ?? meta.participants?.length ?? 0,
      announce: Boolean(meta.announce),
      restrict: Boolean(meta.restrict),
      participants: await this.#participantsOf(meta.participants),
    };
  }

  /** Every group this account is in, without the member lists. */
  async listGroups() {
    this.#assertConnected();
    let groups;
    try {
      groups = Object.values(await this.#conn.groupFetchAllParticipating());
    } catch (err) {
      throw wrapError(err);
    }
    return groups
      .map((group) => {
        this.#groupNames.set(group.id, group.subject);
        return {
          id: group.id,
          name: group.subject ?? null,
          description: group.desc ?? null,
          size: group.size ?? group.participants?.length ?? 0,
          announce: Boolean(group.announce),
          restrict: Boolean(group.restrict),
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Both forms of a person's id — phone number and LID — and the name they
   * go by, from whichever form is given.
   */
  async resolveContact(value) {
    this.#assertConnected();
    const raw = String(value ?? "").trim();
    const jid = /@/.test(raw) ? raw : this.toJid(raw);
    const identity = await this.resolveIdentity(jid);
    return {
      jid: identity.jid,
      phone: identity.phone ?? phoneOf(jid),
      lid: identity.lid,
      push_name: this.#nameOf(identity),
    };
  }

  async sendPresenceUpdate(type, phone) {
    this.#assertConnected();
    try {
      await this.#conn.sendPresenceUpdate(
        type,
        phone ? this.toJid(phone) : undefined,
      );
    } catch (err) {
      throw wrapError(err);
    }
  }

  async presenceSubscribe(phone) {
    this.#assertConnected();
    const id = this.toJid(phone);

    if (!(await this.#exists(id))) {
      throw new NumberNotFoundError(phone);
    }

    try {
      await this.#conn.presenceSubscribe(id);
    } catch (err) {
      throw wrapError(err);
    }
  }

  async updateProfileStatus(status) {
    this.#assertConnected();
    try {
      await this.#conn.updateProfileStatus(status);
    } catch (err) {
      throw wrapError(err);
    }
  }

  /** Keeps re-sending a presence so the account can appear permanently online. */
  setSendPresenceUpdateInterval(type, phone) {
    clearInterval(this.#presenceInterval);
    if (!type) return;

    const push = () =>
      this.sendPresenceUpdate(type, phone).catch(() =>
        clearInterval(this.#presenceInterval),
      );

    push();
    this.#presenceInterval = setInterval(push, 10000);
  }
}
