/**
 * Group chats are noisy: with the Hornero number in a group, every message any
 * member writes would reach Home Assistant as an event. This narrows that down
 * to the messages actually addressed to Hornero — those that mention its
 * number, or reply to something it sent.
 *
 * Direct chats are unaffected: a message sent to you privately is addressed to
 * you by definition.
 */

/** Strips the device suffix, so 12:34@s.whatsapp.net matches 12@s.whatsapp.net. */
const bare = (jid) => String(jid ?? "").replace(/:\d+(?=@)/, "");

/**
 * Every `contextInfo` in the message, wherever it sits. A mention can ride on
 * an extended text, an image caption, a video, a document — each message type
 * carries its own copy.
 */
const contextInfos = (message, depth = 0) => {
  if (!message || typeof message !== "object" || depth > 4) return [];

  const found = [];
  for (const [key, value] of Object.entries(message)) {
    if (key === "contextInfo" && value && typeof value === "object") {
      found.push(value);
    } else if (value && typeof value === "object") {
      found.push(...contextInfos(value, depth + 1));
    }
  }
  return found;
};

/**
 * True when the message mentions one of `ownJids`, or quotes a message Hornero
 * sent. Both forms of the account's identity (phone and LID) should be passed,
 * since a group may address it either way.
 */
export const addressesMe = (msg, ownJids = []) => {
  const mine = new Set(ownJids.filter(Boolean).map(bare));
  if (mine.size === 0) return false;

  // Fallback: a typed "@<number>" in the text, for when WhatsApp sends the
  // mention without (or with an unmatched) mentionedJid.
  const text = JSON.stringify(msg?.message ?? {});
  for (const jid of mine) {
    const user = jid.split("@")[0];
    if (user && text.includes(`@${user}`)) return true;
  }

  return contextInfos(msg?.message).some((ctx) => {
    if ((ctx.mentionedJid ?? []).some((jid) => mine.has(bare(jid))))
      return true;
    // A reply carries the author of the quoted message.
    return [ctx.participant, ctx.participantAlt].some(
      (jid) => jid && mine.has(bare(jid)),
    );
  });
};

/** Whether this message should reach Home Assistant under the group rule. */
export const passesMentionRule = (msg, { ownJids, enabled }) => {
  if (!enabled) return true;
  if (!String(msg?.key?.remoteJid ?? "").endsWith("@g.us")) return true;
  return addressesMe(msg, ownJids);
};
