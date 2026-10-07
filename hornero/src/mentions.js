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
 * Walks the message's own fields, never the message it quotes: a reply to
 * someone else's message that mentioned Hornero is not addressed to Hornero.
 */
const walk = (message, visit, depth = 0) => {
  if (!message || typeof message !== "object" || depth > 4) return;
  for (const [key, value] of Object.entries(message)) {
    if (key === "quotedMessage" || !value || typeof value !== "object") continue;
    if (key === "contextInfo") visit.context(value);
    walk(value, visit, depth + 1);
  }
  for (const key of ["conversation", "text", "caption"]) {
    if (typeof message[key] === "string") visit.text(message[key]);
  }
};

/**
 * Every `contextInfo` and visible text in the message. A mention can ride on
 * an extended text, an image caption, a video, a document — each message type
 * carries its own copy.
 */
const partsOf = (message) => {
  const contexts = [];
  const texts = [];
  walk(message, { context: (c) => contexts.push(c), text: (t) => texts.push(t) });
  return { contexts, texts };
};

/** The ids a message mentions, for logging why it was dropped. */
export const mentionedJids = (msg) =>
  partsOf(msg?.message).contexts.flatMap((ctx) => ctx.mentionedJid ?? []);

/**
 * True when the message mentions one of `ownJids`, or replies to a message
 * Hornero sent. Both forms of the account's identity (phone and LID) should be
 * passed, since a group may address it either way.
 */
export const addressesMe = (msg, ownJids = []) => {
  const mine = new Set(ownJids.filter(Boolean).map(bare));
  if (mine.size === 0) return false;

  const { contexts, texts } = partsOf(msg?.message);

  const addressed = contexts.some((ctx) => {
    if ((ctx.mentionedJid ?? []).some((jid) => mine.has(bare(jid))))
      return true;
    // A reply names the author of the quoted message; only a real reply does.
    if (!ctx.stanzaId && !ctx.quotedMessage) return false;
    return [ctx.participant, ctx.participantAlt].some(
      (jid) => jid && mine.has(bare(jid)),
    );
  });
  if (addressed) return true;

  // Fallback: "@<number>" typed by hand, which WhatsApp may send without a
  // mentionedJid. The digit lookahead keeps a longer number from matching.
  const users = [...mine].map((jid) => jid.split("@")[0]).filter(Boolean);
  return texts.some((text) =>
    users.some((user) => new RegExp(`@${user}(?!\\d)`).test(text)),
  );
};

/** Whether this message should reach Home Assistant under the group rule. */
export const passesMentionRule = (msg, { ownJids, enabled }) => {
  if (!enabled) return true;
  if (!String(msg?.key?.remoteJid ?? "").endsWith("@g.us")) return true;
  return addressesMe(msg, ownJids);
};
