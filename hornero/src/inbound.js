import { normalizeMessageContent } from "baileys";

/**
 * Summaries added to incoming events, so automations do not have to dig
 * through the raw message: what media came with it, and what it replies to.
 * They only ever add fields; the raw message stays where it always was.
 */

/** Message types that carry a downloadable file, and the kind they map to. */
export const MEDIA_TYPES = {
  imageMessage: "image",
  audioMessage: "audio",
  videoMessage: "video",
  ptvMessage: "video",
  documentMessage: "document",
  stickerMessage: "sticker",
};

/** Strips the device suffix, so 12:34@s.whatsapp.net becomes 12@s.whatsapp.net. */
export const bareJid = (jid) =>
  jid ? String(jid).replace(/:\d+(?=@)/, "") : null;

export const isLid = (jid) => String(jid ?? "").endsWith("@lid");
export const isPhoneJid = (jid) =>
  String(jid ?? "").endsWith("@s.whatsapp.net");

/** The phone number in a phone-number JID, digits only; null otherwise. */
export const phoneOf = (jid) =>
  isPhoneJid(jid) ? bareJid(jid).split("@")[0] : null;

/**
 * Picks the phone and LID forms out of a set of ids that all name the same
 * person — a key carries one in `participant` and the other in
 * `participantAlt`, in whichever order WhatsApp chose.
 */
export const identityOf = (...jids) => {
  const ids = jids.filter(Boolean).map(bareJid);
  const pn = ids.find(isPhoneJid) ?? null;
  const lid = ids.find(isLid) ?? null;
  return { jid: pn ?? lid ?? ids[0] ?? null, phone: phoneOf(pn), lid };
};

/** Turns Baileys' Long/number/string sizes into a plain number. */
const toNumber = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/** The media part of a message, unwrapping view-once and similar envelopes. */
export const findMedia = (message) => {
  const content = normalizeMessageContent(message);
  if (!content) return null;
  for (const [type, kind] of Object.entries(MEDIA_TYPES)) {
    if (content[type] && typeof content[type] === "object") {
      return { type, kind, media: content[type] };
    }
  }
  return null;
};

/**
 * What an automation needs to decide whether to fetch the file: never the
 * file itself. `media_id` is what `download_media` takes.
 */
export const mediaInfo = (msg) => {
  const found = findMedia(msg?.message);
  if (!found || !msg?.key?.id) return null;
  const { kind, media } = found;

  return {
    type: kind,
    mimetype: media.mimetype ?? null,
    size: toNumber(media.fileLength),
    seconds:
      kind === "audio" || kind === "video" ? toNumber(media.seconds) : null,
    ptt: kind === "audio" ? Boolean(media.ptt) : false,
    caption: typeof media.caption === "string" ? media.caption : null,
    file_name: media.fileName ?? null,
    media_id: msg.key.id,
  };
};

/** The contextInfo of whatever the message is, text or media. */
const contextOf = (message) => {
  const content = normalizeMessageContent(message);
  if (!content || typeof content !== "object") return null;
  for (const value of Object.values(content)) {
    if (value && typeof value === "object" && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return null;
};

/** The visible text of a quoted message, when it has one. */
const quotedText = (quoted) => {
  const content = normalizeMessageContent(quoted);
  if (!content) return null;
  if (typeof content.conversation === "string") return content.conversation;
  if (typeof content.extendedTextMessage?.text === "string") {
    return content.extendedTextMessage.text;
  }
  const media = findMedia(content)?.media;
  return typeof media?.caption === "string" ? media.caption : null;
};

/**
 * When the message is a reply: which message it answers, who wrote that one,
 * and whether it was this account. `ownJids` should hold both forms of the
 * account's identity, since a group may address it either way.
 */
export const quotedInfo = (msg, ownJids = []) => {
  const ctx = contextOf(msg?.message);
  if (!ctx?.stanzaId) return null;

  const mine = new Set(ownJids.filter(Boolean).map(bareJid));
  // In a direct chat the author may be left out; then it is the other side
  // unless the quoted message was ours, which WhatsApp marks with our id.
  const authorIds = [ctx.participant, ctx.participantAlt].filter(Boolean);
  const author = identityOf(...authorIds);
  const fromMe = authorIds.some((jid) => mine.has(bareJid(jid)));

  return {
    message_id: ctx.stanzaId,
    author: author.jid,
    author_phone: author.phone,
    author_lid: author.lid,
    from_me: fromMe,
    text: quotedText(ctx.quotedMessage),
  };
};
