import fs from "node:fs/promises";
import path from "node:path";
import { BufferJSON } from "baileys";

/**
 * Recent messages, kept so they can still be acted on after the event that
 * carried them: media is downloaded on request, a reaction or an edit needs
 * the full key of its target, and a poll vote can only be decrypted with the
 * secret of the poll it answers.
 *
 * Only metadata is kept — a media message holds the link and the key to
 * decrypt it, never the file itself. Each entry expires on its own, and the
 * whole store is saved next to the session, so a restart of the add-on does
 * not lose what was received in the meantime. Logging out wipes it with the
 * session.
 */

const FILE_NAME = "hornero-messages.json";
const SAVE_DELAY_MS = 5000;

export class MessageStore {
  #file;
  #limit;
  #logger;
  #entries = new Map();
  #saveTimer = null;
  #now;

  constructor({ dir, limit = 5000, logger, now = Date.now } = {}) {
    this.#file = dir ? path.join(dir, FILE_NAME) : null;
    this.#limit = limit;
    this.#logger = logger;
    this.#now = now;
  }

  /** Loads what a previous run saved, dropping whatever has expired since. */
  async load() {
    if (!this.#file) return;
    try {
      const raw = await fs.readFile(this.#file, "utf8");
      const saved = JSON.parse(raw, BufferJSON.reviver);
      for (const entry of saved.entries ?? []) {
        if (entry?.id && entry.expiresAt > this.#now()) {
          this.#entries.set(entry.id, entry);
        }
      }
    } catch {
      // nothing saved yet, or an unreadable file: start empty
    }
  }

  /**
   * Keeps a message for `ttlMs`. A message stored again keeps the longer of
   * the two lifetimes, so a poll is not shortened by a later plain save.
   */
  put(msg, { ttlMs, kind = "message" } = {}) {
    const id = msg?.key?.id;
    if (!id || !(ttlMs > 0)) return;

    const previous = this.#entries.get(id);
    const expiresAt = Math.max(previous?.expiresAt ?? 0, this.#now() + ttlMs);
    this.#entries.delete(id);
    this.#entries.set(id, {
      id,
      kind: previous?.kind === "poll" ? "poll" : kind,
      expiresAt,
      msg,
    });

    this.#prune();
    this.#scheduleSave();
  }

  /** The stored message with this id, or null when unknown or expired. */
  get(id) {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return null;
    }
    return entry.msg;
  }

  get size() {
    return this.#entries.size;
  }

  #prune() {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(id);
    }
    // Oldest first: a Map iterates in insertion order. Polls live longest and
    // are what a vote needs, so plain messages go first.
    for (const kind of ["message", "poll"]) {
      if (this.#entries.size <= this.#limit) return;
      for (const [id, entry] of this.#entries) {
        if (this.#entries.size <= this.#limit) return;
        if (entry.kind === kind) this.#entries.delete(id);
      }
    }
  }

  #scheduleSave() {
    if (!this.#file || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.#saveTimer.unref?.();
  }

  /** Writes the store now. Called on a timer, and on shutdown. */
  async save() {
    if (!this.#file) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    this.#prune();
    try {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(
        this.#file,
        JSON.stringify(
          { entries: [...this.#entries.values()] },
          BufferJSON.replacer,
        ),
      );
    } catch (err) {
      this.#logger?.warn(
        { err: err.message },
        "could not save the recent messages",
      );
    }
  }
}
