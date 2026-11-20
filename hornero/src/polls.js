import crypto from "node:crypto";
import { decryptPollVote, jidNormalizedUser } from "baileys";

/**
 * Poll votes arrive encrypted with a secret only the poll's creator holds,
 * so they can be read for polls this account sent — which is why sent polls
 * are kept in the message store. Baileys 7 no longer decrypts them itself.
 */

/** The creation part of a poll message, whichever version it is. */
export const pollCreationOf = (message) =>
  message?.pollCreationMessage ??
  message?.pollCreationMessageV2 ??
  message?.pollCreationMessageV3 ??
  null;

export const pollOptions = (message) =>
  (pollCreationOf(message)?.options ?? []).map((o) => o.optionName ?? "");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

/** Maps the hashes a vote carries back to the option names. */
export const optionNames = (selected, options) => {
  const byHash = new Map(
    options.map((name) => [sha256(name).toString("hex"), name]),
  );
  return (selected ?? [])
    .map((hash) => byHash.get(Buffer.from(hash).toString("hex")) ?? null)
    .filter((name) => name !== null);
};

const unique = (values) => [
  ...new Set(values.filter(Boolean).map((jid) => jidNormalizedUser(jid))),
];

/**
 * Decrypts a vote for a poll held in `poll` (the stored WAMessage). The vote
 * is bound to the exact ids of creator and voter, and either may be the
 * phone or the LID form depending on how the chat is addressed, so each pair
 * is tried until one authenticates.
 *
 * Returns the chosen option names (empty when the vote was withdrawn), or
 * null when it cannot be decrypted.
 */
export const decryptVote = (voteMsg, poll, { ownJids }) => {
  const update = voteMsg?.message?.pollUpdateMessage;
  const secret = poll?.message?.messageContextInfo?.messageSecret;
  if (!update?.vote || !secret) return null;

  const key = voteMsg.key ?? {};
  const voters = unique([
    key.participant,
    key.participantAlt,
    ...(key.participant ? [] : [key.remoteJid, key.remoteJidAlt]),
  ]);
  const creators = unique(ownJids);
  const pollMsgId = update.pollCreationMessageKey?.id ?? poll.key?.id;

  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const vote = decryptPollVote(update.vote, {
          pollCreatorJid,
          pollMsgId,
          pollEncKey: secret,
          voterJid,
        });
        return optionNames(vote.selectedOptions, pollOptions(poll.message));
      } catch {
        // wrong pair of ids; the GCM tag does not match, try the next one
      }
    }
  }
  return null;
};
