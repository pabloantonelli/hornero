import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptVote } from "./helpers/poll-vote.js";

/** A stand-in for the Baileys socket: just enough surface for the client. */
const fakeSocket = () => {
  const ev = new EventEmitter();
  return {
    ev,
    user: { id: "5490000000000:7@s.whatsapp.net", lid: "999:7@lid" },
    sendMessage: vi.fn(async (jid, content) => ({
      key: {
        id: `SENT${Math.random().toString(16).slice(2, 8)}`,
        remoteJid: jid,
        fromMe: true,
      },
      messageTimestamp: 1737400000,
      message: content.poll
        ? {
            messageContextInfo: { messageSecret: crypto.randomBytes(32) },
            pollCreationMessageV3: {
              name: content.poll.name,
              options: content.poll.values.map((optionName) => ({
                optionName,
              })),
            },
          }
        : { conversation: content.text ?? "" },
    })),
    sendPresenceUpdate: vi.fn(async () => {}),
    onWhatsApp: vi.fn(async () => [{ exists: true }]),
    groupMetadata: vi.fn(),
    groupFetchAllParticipating: vi.fn(),
    updateMediaMessage: vi.fn(),
    end: vi.fn(),
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn(async (lid) =>
          lid === "111@lid" ? "5491111111111@s.whatsapp.net" : null,
        ),
        getLIDForPN: vi.fn(async (pn) =>
          pn === "5491111111111@s.whatsapp.net" ? "111@lid" : null,
        ),
      },
    },
  };
};

let socket;
const download = vi.fn();

vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    makeWASocket: vi.fn(() => socket),
    useMultiFileAuthState: vi.fn(async () => ({
      state: {
        creds: {
          me: { id: "5490000000000:7@s.whatsapp.net", lid: "999:7@lid" },
        },
        keys: {},
      },
      saveCreds: vi.fn(),
    })),
    makeCacheableSignalKeyStore: vi.fn((keys) => keys),
    fetchLatestWaWebVersion: vi.fn(async () => ({
      version: [2, 3000, 1],
      isLatest: true,
    })),
    fetchLatestBaileysVersion: vi.fn(async () => ({
      version: [2, 3000, 1],
      isLatest: true,
    })),
    downloadMediaMessage: (...args) => download(...args),
  };
});

const { BaileysClient } = await import("../src/baileys-client.js");

const settings = (values = {}) => {
  const all = {
    typingIndicator: false,
    mediaCacheHours: 24,
    mediaMaxMb: 20,
    ...values,
  };
  return { get: (k) => all[k], typingMaxMs: 0 };
};

let dir;
let client;

const connect = async (values) => {
  socket = fakeSocket();
  client = new BaileysClient({ path: dir, settings: settings(values) });
  await client.start();
  socket.ev.emit("connection.update", { connection: "open" });
  return client;
};

const nextEvent = (name) =>
  new Promise((resolve) => client.once(name, resolve));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hornero-client-"));
  download.mockReset();
});

afterEach(async () => {
  await client?.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("reacciones", () => {
  it("emite la reacción con el teléfono del autor resuelto desde su LID", async () => {
    await connect();
    const event = nextEvent("reaction");
    socket.ev.emit("messages.reaction", [
      {
        key: { id: "MINE", remoteJid: "120363@g.us", fromMe: true },
        reaction: {
          text: "❤️",
          key: {
            id: "R1",
            remoteJid: "120363@g.us",
            participant: "111@lid",
            fromMe: false,
          },
        },
      },
    ]);

    expect(await event).toMatchObject({
      chat: "120363@g.us",
      author: "5491111111111@s.whatsapp.net",
      author_phone: "5491111111111",
      author_lid: "111@lid",
      message_id: "MINE",
      emoji: "❤️",
      removed: false,
      from_me: true,
    });
  });

  it("marca como quitada una reacción vacía e ignora las propias", async () => {
    await connect();
    const seen = [];
    client.on("reaction", (r) => seen.push(r));
    socket.ev.emit("messages.reaction", [
      {
        key: { id: "M", remoteJid: "x@s.whatsapp.net" },
        reaction: { text: "👍", key: { fromMe: true } },
      },
      {
        key: {
          id: "M",
          remoteJid: "5491111111111@s.whatsapp.net",
          fromMe: false,
        },
        reaction: {
          text: "",
          key: { id: "R2", remoteJid: "5491111111111@s.whatsapp.net" },
        },
      },
    ]);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ emoji: "", removed: true, from_me: false });
  });
});

describe("encuestas", () => {
  it("descifra los votos de una encuesta enviada desde acá", async () => {
    await connect();
    const sent = await client.sendPoll("120363@g.us", {
      question: "¿Cena?",
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    });
    expect(socket.sendMessage).toHaveBeenCalledWith(
      "120363@g.us",
      {
        poll: {
          name: "¿Cena?",
          values: ["Pizza", "Sushi"],
          selectableCount: 1,
        },
      },
      undefined,
    );

    const secret =
      socket.sendMessage.mock.results[0].value &&
      (await socket.sendMessage.mock.results[0].value).message
        .messageContextInfo.messageSecret;
    const vote = encryptVote({
      selected: ["Sushi"],
      secret,
      pollMsgId: sent.key.id,
      creator: "5490000000000@s.whatsapp.net",
      voter: "5491111111111@s.whatsapp.net",
    });

    const event = nextEvent("poll_vote");
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "V1",
            remoteJid: "120363@g.us",
            participant: "5491111111111@s.whatsapp.net",
            participantAlt: "111@lid",
          },
          pushName: "Ana",
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: {
                id: sent.key.id,
                remoteJid: "120363@g.us",
                fromMe: true,
              },
              vote,
            },
          },
        },
      ],
    });

    expect(await event).toMatchObject({
      chat: "120363@g.us",
      author: "5491111111111@s.whatsapp.net",
      author_lid: "111@lid",
      push_name: "Ana",
      poll_message_id: sent.key.id,
      poll_name: "¿Cena?",
      selected_options: ["Sushi"],
    });
  });

  it("ignora votos de encuestas que no conoce", async () => {
    await connect();
    const seen = vi.fn();
    client.on("poll_vote", seen);
    socket.ev.emit("messages.upsert", {
      messages: [
        {
          key: { id: "V", remoteJid: "x@s.whatsapp.net" },
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: { id: "OTRA" },
              vote: { encPayload: Buffer.alloc(32), encIv: Buffer.alloc(12) },
            },
          },
        },
      ],
    });
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("grupos", () => {
  it("avisa altas de participantes con ambas formas de su id", async () => {
    await connect();
    const event = nextEvent("group_update");
    socket.ev.emit("group-participants.update", {
      id: "120363@g.us",
      author: "5491111111111@s.whatsapp.net",
      participants: [{ id: "111@lid", admin: null }],
      action: "add",
    });

    expect(await event).toEqual({
      chat: "120363@g.us",
      group_name: null,
      action: "add",
      participants: [
        {
          id: "5491111111111@s.whatsapp.net",
          phone: "5491111111111",
          lid: "111@lid",
          admin: null,
        },
      ],
      author: "5491111111111@s.whatsapp.net",
      author_phone: "5491111111111",
      author_lid: "111@lid",
      changes: {},
    });
  });

  it("avisa un cambio de nombre, pero no el refresco con la metadata completa", async () => {
    await connect();
    const seen = [];
    client.on("group_update", (u) => seen.push(u));
    socket.ev.emit("groups.update", [
      { id: "120363@g.us", subject: "Todo", participants: [], creation: 1 },
      { id: "120363@g.us", subject: "Familia", author: "111@lid" },
    ]);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      action: "subject",
      group_name: "Familia",
      changes: { subject: "Familia" },
      author_phone: "5491111111111",
    });
  });

  it("devuelve un grupo con teléfono, LID y rol de cada miembro", async () => {
    await connect();
    socket.groupMetadata.mockResolvedValue({
      id: "120363@g.us",
      subject: "Familia",
      desc: "La de siempre",
      owner: "5491111111111@s.whatsapp.net",
      creation: 1700000000,
      size: 2,
      participants: [
        { id: "111@lid", admin: "superadmin" },
        {
          id: "222@lid",
          phoneNumber: "5491222222222@s.whatsapp.net",
          admin: null,
        },
      ],
    });

    expect(await client.getGroup("120363@g.us")).toEqual({
      id: "120363@g.us",
      name: "Familia",
      description: "La de siempre",
      owner: "5491111111111@s.whatsapp.net",
      created: "2023-11-14T22:13:20.000Z",
      size: 2,
      announce: false,
      restrict: false,
      participants: [
        {
          id: "5491111111111@s.whatsapp.net",
          phone: "5491111111111",
          lid: "111@lid",
          admin: "superadmin",
        },
        {
          id: "5491222222222@s.whatsapp.net",
          phone: "5491222222222",
          lid: "222@lid",
          admin: null,
        },
      ],
    });
  });

  it("rechaza ids que no son de grupo", async () => {
    await connect();
    await expect(client.getGroup("5491111111111")).rejects.toMatchObject({
      code: 400,
    });
  });

  it("lista los grupos ordenados por nombre", async () => {
    await connect();
    socket.groupFetchAllParticipating.mockResolvedValue({
      b: { id: "b@g.us", subject: "Vecinos", participants: [1, 2, 3] },
      a: {
        id: "a@g.us",
        subject: "Familia",
        desc: "x",
        size: 5,
        announce: true,
      },
    });
    expect(await client.listGroups()).toEqual([
      {
        id: "a@g.us",
        name: "Familia",
        description: "x",
        size: 5,
        announce: true,
        restrict: false,
      },
      {
        id: "b@g.us",
        name: "Vecinos",
        description: null,
        size: 3,
        announce: false,
        restrict: false,
      },
    ]);
  });
});

describe("contactos", () => {
  it("pasa de LID a teléfono, con el nombre con el que escribió", async () => {
    await connect();
    socket.ev.emit("messages.upsert", {
      messages: [
        {
          key: {
            id: "M",
            remoteJid: "111@lid",
            remoteJidAlt: "5491111111111@s.whatsapp.net",
          },
          pushName: "Ana",
          message: { conversation: "hola" },
        },
      ],
    });
    expect(await client.resolveContact("111@lid")).toEqual({
      jid: "5491111111111@s.whatsapp.net",
      phone: "5491111111111",
      lid: "111@lid",
      push_name: "Ana",
    });
  });

  it("pasa de teléfono a LID", async () => {
    await connect();
    expect(await client.resolveContact("+54 9 11 1111-1111")).toMatchObject({
      phone: "5491111111111",
      lid: "111@lid",
    });
  });
});

describe("acciones sobre mensajes", () => {
  const incoming = {
    key: {
      id: "IN1",
      remoteJid: "120363@g.us",
      participant: "5491111111111@s.whatsapp.net",
      fromMe: false,
    },
    message: { conversation: "hola" },
  };

  it("reacciona a un mensaje reciente usando su clave completa", async () => {
    await connect();
    client.remember(incoming);
    await client.react({ messageId: "IN1", emoji: "👀" });

    expect(socket.sendMessage).toHaveBeenCalledWith(
      "120363@g.us",
      { react: { text: "👀", key: incoming.key } },
      undefined,
    );
  });

  it("pide el chat cuando el mensaje no es reciente", async () => {
    await connect();
    expect(() => client.keyFor({ messageId: "VIEJO" })).toThrow(
      /not among the recent/,
    );
    expect(
      client.keyFor({ messageId: "VIEJO", chat: "5491111111111" }),
    ).toEqual({
      remoteJid: "5491111111111@s.whatsapp.net",
      id: "VIEJO",
      fromMe: false,
    });
  });

  it("edita y borra un mensaje propio", async () => {
    await connect();
    const sent = await client.sendMessage("5491111111111", { text: "hola" });

    await client.editMessage({ messageId: sent.key.id, text: "chau" });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      "5491111111111@s.whatsapp.net",
      { text: "chau", edit: sent.key },
      undefined,
    );

    await client.deleteMessage({ messageId: sent.key.id });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      "5491111111111@s.whatsapp.net",
      { delete: sent.key },
      undefined,
    );
  });

  it("no edita mensajes ajenos", async () => {
    await connect();
    client.remember(incoming);
    expect(() => client.editMessage({ messageId: "IN1", text: "x" })).toThrow(
      /Only messages sent from here/,
    );
  });

  it("manda una ubicación", async () => {
    await connect();
    await client.sendLocation("5491111111111", {
      latitude: -34.6,
      longitude: -58.4,
      name: "Obelisco",
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      "5491111111111@s.whatsapp.net",
      {
        location: {
          degreesLatitude: -34.6,
          degreesLongitude: -58.4,
          name: "Obelisco",
        },
      },
      undefined,
    );
  });
});

describe("descarga de media", () => {
  const voice = {
    key: { id: "AUD1", remoteJid: "5491111111111@s.whatsapp.net" },
    message: {
      audioMessage: {
        mimetype: "audio/ogg; codecs=opus",
        fileLength: 3,
        seconds: 2,
        ptt: true,
        url: "u",
      },
    },
  };

  it("baja el archivo de un mensaje recordado", async () => {
    await connect();
    client.remember(voice);
    download.mockResolvedValue(Buffer.from("ogg"));

    const result = await client.downloadMedia("AUD1");
    expect(result.buffer.toString()).toBe("ogg");
    expect(result.mimetype).toBe("audio/ogg; codecs=opus");
    expect(result.info).toMatchObject({ type: "audio", ptt: true, size: 3 });
  });

  it("pide el re-envío cuando el enlace venció y guarda el mensaje nuevo", async () => {
    await connect();
    client.remember(voice);
    const refreshed = {
      ...voice,
      message: {
        audioMessage: { ...voice.message.audioMessage, url: "nuevo" },
      },
    };
    socket.updateMediaMessage.mockResolvedValue(refreshed);
    download.mockImplementation(async (msg, type, opts, ctx) => {
      await ctx.reuploadRequest(msg);
      return Buffer.from("ogg");
    });

    await client.downloadMedia("AUD1");
    expect(socket.updateMediaMessage).toHaveBeenCalledWith(voice);
  });

  it("no baja lo que no recuerda, como el media de un remitente bloqueado", async () => {
    await connect();
    await expect(client.downloadMedia("NADA")).rejects.toMatchObject({
      code: 404,
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("respeta el tope de tamaño configurado", async () => {
    await connect({ mediaMaxMb: 1 });
    client.remember({
      key: { id: "BIG", remoteJid: "x@s.whatsapp.net" },
      message: { videoMessage: { mimetype: "video/mp4", fileLength: 5e6 } },
    });
    await expect(client.downloadMedia("BIG")).rejects.toMatchObject({
      code: 413,
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("no recuerda nada con la caché en cero horas", async () => {
    await connect({ mediaCacheHours: 0 });
    client.remember(voice);
    await expect(client.downloadMedia("AUD1")).rejects.toMatchObject({
      code: 404,
    });
  });
});
