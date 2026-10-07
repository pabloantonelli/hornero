import fs from "node:fs/promises";
import path from "node:path";

/**
 * Incoming messages reach Home Assistant as events, and automations act on
 * them, so an unfiltered inbox means any stranger can trigger them. The
 * allowlist decides which senders are allowed through.
 *
 * It lives in /data rather than the add-on options so it can be edited from
 * the panel; the `allowed_senders` option seeds it on first run.
 */

const SUFFIXES = ["@s.whatsapp.net", "@g.us", "@broadcast", "@lid"];

/** Accepts phone numbers in any shape, plus full JIDs, and normalises them. */
export const normaliseEntry = (entry) => {
  const value = String(entry ?? "").trim();
  if (!value) return null;
  if (SUFFIXES.some((suffix) => value.endsWith(suffix))) return value;
  const digits = value.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
};

export const buildAllowlist = (entries) =>
  new Set((entries ?? []).map(normaliseEntry).filter(Boolean));

/**
 * Every identifier a message can be matched against.
 *
 * A group message carries the group in `remoteJid` and the author in
 * `participant`. WhatsApp also addresses people by LID (`…@lid`), which hides
 * the phone number; Baileys puts the other form of the same identity in the
 * `Alt` fields, so both are considered — otherwise an allowlist of phone
 * numbers would never match a LID-addressed sender.
 */
export const identifiersOf = (msg) =>
  [
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.key?.participantAlt,
  ].filter(Boolean);

/** Who may write in an allowed group: every member, or only allowed people. */
export const GROUP_MODES = ["all", "members"];
export const DEFAULT_GROUP_MODE = "all";

export const isGroupJid = (jid) => String(jid ?? "").endsWith("@g.us");

/** Strips the device suffix, so 12:34@s.whatsapp.net matches 12@s.whatsapp.net. */
export const bareJid = (jid) => String(jid ?? "").replace(/:\d+(?=@)/, "");

const listed = (allowlist, jids) =>
  jids.some(
    (jid) => jid && (allowlist.has(jid) || allowlist.has(bareJid(jid))),
  );

/**
 * A person on the list is accepted in a direct chat. A group must be on the
 * list itself: in `all` mode anyone posting in it is accepted, in `members`
 * mode only authors who are on the list too. Being on the list does not open
 * groups that are not — that would let anyone add you to a group and use it.
 */
export const isAllowed = (msg, allowlist, groupModes = {}) => {
  if (!allowlist || allowlist.size === 0) return true;

  const key = msg?.key ?? {};
  if (!isGroupJid(key.remoteJid)) {
    return listed(allowlist, [key.remoteJid, key.remoteJidAlt]);
  }

  if (!allowlist.has(key.remoteJid)) return false;
  if ((groupModes[key.remoteJid] ?? DEFAULT_GROUP_MODE) === "all") return true;
  return listed(allowlist, [key.participant, key.participantAlt]);
};

/** Keeps a valid mode only for groups that are on the list. */
const cleanModes = (modes, entries) =>
  Object.fromEntries(
    Object.entries(modes ?? {}).filter(
      ([jid, mode]) =>
        isGroupJid(jid) && entries.has(jid) && GROUP_MODES.includes(mode),
    ),
  );

/** Persisted, editable allowlist. */
export class AllowlistStore {
  #file;
  #entries = [];
  #set = new Set();
  #groupModes = {};
  #logger;

  constructor({ dataDir, logger }) {
    this.#file = path.join(dataDir, "allowlist.json");
    this.#logger = logger;
  }

  /** Loads from disk, falling back to the add-on option on first run. */
  async load(seed) {
    try {
      const raw = await fs.readFile(this.#file, "utf8");
      const saved = JSON.parse(raw);
      this.#apply(saved.entries ?? [], saved.groupModes);
      return;
    } catch {
      // not saved yet
    }

    this.#apply(seed ?? []);
    if (this.#entries.length) await this.#persist();
  }

  #apply(entries, groupModes) {
    this.#set = buildAllowlist(entries);
    this.#entries = [...this.#set];
    this.#groupModes = cleanModes(groupModes, this.#set);
  }

  async #persist() {
    try {
      await fs.writeFile(
        this.#file,
        JSON.stringify(
          { entries: this.#entries, groupModes: this.#groupModes },
          null,
          2,
        ),
      );
    } catch (err) {
      this.#logger?.error({ err: err.message }, "could not save the allowlist");
    }
  }

  get entries() {
    return [...this.#entries];
  }

  /** Mode per allowed group; a group missing here admits every member. */
  get groupModes() {
    return { ...this.#groupModes };
  }

  /** True while empty: an empty allowlist accepts everyone. */
  get open() {
    return this.#set.size === 0;
  }

  /** Modes default to the current ones, so a caller may send entries alone. */
  async replace(entries, groupModes = this.#groupModes) {
    this.#apply(entries, groupModes);
    await this.#persist();
    return this.entries;
  }

  allows(msg) {
    return isAllowed(msg, this.#set, this.#groupModes);
  }
}
