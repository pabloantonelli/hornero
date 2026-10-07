import EventEmitter2 from "eventemitter2";
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from "baileys";
import PQueue from "p-queue";
import pino from "pino";

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
      // No message store is kept, so decryption retries cannot be served.
      getMessage: async () => undefined,
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
  }

  /**
   * The version lookup hits the network. Cache it and fall back to Baileys'
   * bundled default so a DNS hiccup cannot break an entire reconnection.
   */
  async #resolveVersion() {
    try {
      const { version } = await fetchLatestBaileysVersion();
      this.#version = version;
    } catch (err) {
      this.#logger.warn(
        { err: err.message },
        "could not fetch latest WhatsApp Web version, using cached/default",
      );
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
      delete msg.message.messageContextInfo;
      const [type] = Object.keys(msg.message);
      this.emit("msg", { type, ...msg });
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

  /** Sends a message. Returns Baileys' result, which carries the message id. */
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
