import crypto from "node:crypto";
import { aesEncryptGCM, hmacSign, proto } from "baileys";

const sha = (text) => crypto.createHash("sha256").update(text).digest();

/** Encrypts a vote the way the voter's phone does. */
export const encryptVote = ({
  selected,
  secret,
  pollMsgId,
  creator,
  voter,
}) => {
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(creator),
    Buffer.from(voter),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(secret, new Uint8Array(32), "sha256");
  const decKey = hmacSign(sign, key0, "sha256");
  const iv = crypto.randomBytes(12);
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: selected.map(sha),
  }).finish();
  return {
    encPayload: aesEncryptGCM(
      plain,
      decKey,
      iv,
      Buffer.from(`${pollMsgId}\u0000${voter}`),
    ),
    encIv: iv,
  };
};
