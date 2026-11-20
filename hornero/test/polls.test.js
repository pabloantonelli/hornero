import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptVote } from "./helpers/poll-vote.js";
import { decryptVote, optionNames } from "../src/polls.js";

const sha = (text) => crypto.createHash("sha256").update(text).digest();

const secret = crypto.randomBytes(32);
const poll = {
  key: { id: "POLL1", remoteJid: "120363@g.us", fromMe: true },
  message: {
    messageContextInfo: { messageSecret: secret },
    pollCreationMessageV3: {
      name: "¿Cena?",
      options: [
        { optionName: "Pizza" },
        { optionName: "Sushi" },
        { optionName: "Tacos" },
      ],
    },
  },
};

const voteFrom = (participant, participantAlt, vote) => ({
  key: { id: "V1", remoteJid: "120363@g.us", participant, participantAlt },
  message: {
    pollUpdateMessage: {
      pollCreationMessageKey: {
        id: "POLL1",
        remoteJid: "120363@g.us",
        fromMe: true,
      },
      vote,
    },
  },
});

describe("decryptVote", () => {
  it("lee las opciones elegidas con el secreto de la encuesta", () => {
    const vote = encryptVote({
      selected: ["Sushi", "Tacos"],
      secret,
      pollMsgId: "POLL1",
      creator: "5490000000000@s.whatsapp.net",
      voter: "5491111111111@s.whatsapp.net",
    });

    expect(
      decryptVote(
        voteFrom("5491111111111@s.whatsapp.net", undefined, vote),
        poll,
        {
          ownJids: ["5490000000000:7@s.whatsapp.net"],
        },
      ),
    ).toEqual(["Sushi", "Tacos"]);
  });

  it("prueba la forma LID del creador y del votante cuando el grupo usa LID", () => {
    const vote = encryptVote({
      selected: ["Pizza"],
      secret,
      pollMsgId: "POLL1",
      creator: "999@lid",
      voter: "111@lid",
    });

    expect(
      decryptVote(
        voteFrom("5491111111111@s.whatsapp.net", "111@lid", vote),
        poll,
        {
          ownJids: ["5490000000000@s.whatsapp.net", "999:4@lid"],
        },
      ),
    ).toEqual(["Pizza"]);
  });

  it("devuelve una lista vacía cuando retiran el voto", () => {
    const vote = encryptVote({
      selected: [],
      secret,
      pollMsgId: "POLL1",
      creator: "5490000000000@s.whatsapp.net",
      voter: "5491111111111@s.whatsapp.net",
    });
    expect(
      decryptVote(
        voteFrom("5491111111111@s.whatsapp.net", undefined, vote),
        poll,
        {
          ownJids: ["5490000000000@s.whatsapp.net"],
        },
      ),
    ).toEqual([]);
  });

  it("devuelve null si el voto no se puede descifrar", () => {
    const vote = encryptVote({
      selected: ["Pizza"],
      secret: crypto.randomBytes(32),
      pollMsgId: "POLL1",
      creator: "5490000000000@s.whatsapp.net",
      voter: "5491111111111@s.whatsapp.net",
    });
    expect(
      decryptVote(
        voteFrom("5491111111111@s.whatsapp.net", undefined, vote),
        poll,
        {
          ownJids: ["5490000000000@s.whatsapp.net"],
        },
      ),
    ).toBeNull();
  });
});

describe("optionNames", () => {
  it("ignora hashes que no corresponden a ninguna opción", () => {
    expect(
      optionNames([sha("Pizza"), sha("Otra")], ["Pizza", "Sushi"]),
    ).toEqual(["Pizza"]);
  });
});
