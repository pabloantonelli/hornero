import { identifiersOf } from "./allowlist.js";

/**
 * Remembers who wrote recently, allowed or not, so the panel can offer a
 * one-click Allow instead of asking people to work out an identifier they
 * never see — WhatsApp increasingly addresses people by LID, which looks
 * nothing like their phone number.
 */
export class RecentSenders {
  #limit;
  #byKey = new Map();

  constructor({ limit = 25 } = {}) {
    this.#limit = limit;
  }

  record(msg, allowed) {
    const ids = identifiersOf(msg);
    if (ids.length === 0) return;

    const isGroup = String(msg.key.remoteJid).endsWith("@g.us");
    // One entry per person and chat: someone ignored in a group stays
    // visible even after others write there.
    const id = isGroup ? msg.key.remoteJid : ids[0];
    const key = isGroup ? `${id}|${msg.key.participant ?? ""}` : id;

    this.#byKey.delete(key);
    this.#byKey.set(key, {
      id,
      ids,
      name: msg.pushName || null,
      group: isGroup,
      // Who wrote in the group, so the panel can let just that person in.
      ...(isGroup && msg.key.participant
        ? {
            author: msg.key.participant,
            authorIds: [msg.key.participant, msg.key.participantAlt].filter(
              Boolean,
            ),
          }
        : {}),
      allowed,
      at: new Date().toISOString(),
    });

    while (this.#byKey.size > this.#limit) {
      this.#byKey.delete(this.#byKey.keys().next().value);
    }
  }

  /** Most recent first. */
  get entries() {
    return [...this.#byKey.values()].reverse();
  }
}
