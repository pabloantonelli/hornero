import { EventEmitter } from "node:events";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AllowlistStore } from "../src/allowlist.js";
import { forwardEvents } from "../src/events.js";

const ANA = "5491111111111@s.whatsapp.net";
const STRANGER = "5499999999999@s.whatsapp.net";
const GROUP = "120363@g.us";

let client;
let ha;
let allowlist;

beforeEach(async () => {
  client = Object.assign(new EventEmitter(), {
    ownJids: ["5490000000000:7@s.whatsapp.net"],
    remember: vi.fn(),
    markRead: vi.fn(async () => 1),
  });
  ha = { fireEvent: vi.fn() };
  allowlist = new AllowlistStore({ dataDir: "/nonexistent" });
  await allowlist.load([ANA, GROUP]);

  forwardEvents({
    client,
    clientId: "default",
    ha,
    allowlist,
    recentSenders: { record: vi.fn() },
    settings: { get: () => false },
    messageLog: {
      recordReceived: vi.fn(),
      markStatus: vi.fn(),
      recordSent: vi.fn(),
      recordFailure: vi.fn(),
    },
    logger: pino({ level: "silent" }),
  });
});

const fired = (name) =>
  ha.fireEvent.mock.calls
    .filter(([event]) => event === name)
    .map(([, data]) => data);

describe("hornero_message", () => {
  it("agrega media y quoted sin tocar los campos de siempre", () => {
    const msg = {
      type: "audioMessage",
      key: { id: "A1", remoteJid: ANA },
      pushName: "Ana",
      message: {
        audioMessage: {
          mimetype: "audio/ogg; codecs=opus",
          seconds: 4,
          ptt: true,
          contextInfo: {
            stanzaId: "Q1",
            participant: "5490000000000@s.whatsapp.net",
          },
        },
      },
    };
    client.emit("msg", msg);

    const [event] = fired("hornero_message");
    expect(event).toMatchObject({
      clientId: "default",
      type: "audioMessage",
      key: msg.key,
      pushName: "Ana",
      message: msg.message,
      media: { type: "audio", ptt: true, seconds: 4, media_id: "A1" },
      quoted: { message_id: "Q1", from_me: true },
    });
    expect(client.remember).toHaveBeenCalledWith(msg);
  });

  it("no agrega media ni quoted a un texto suelto", () => {
    client.emit("msg", {
      key: { id: "T", remoteJid: ANA },
      message: { conversation: "hola" },
    });
    const [event] = fired("hornero_message");
    expect(event).not.toHaveProperty("media");
    expect(event).not.toHaveProperty("quoted");
  });

  it("no guarda el media de un remitente bloqueado ni dispara el evento", () => {
    client.emit("msg", {
      key: { id: "X", remoteJid: STRANGER },
      message: { imageMessage: { mimetype: "image/jpeg" } },
    });
    expect(client.remember).not.toHaveBeenCalled();
    expect(fired("hornero_message")).toHaveLength(0);
  });
});

describe("hornero_reaction", () => {
  it("pasa la reacción de alguien permitido, sin la clave interna", () => {
    client.emit("reaction", {
      key: { remoteJid: ANA },
      chat: ANA,
      author: ANA,
      message_id: "M",
      emoji: "👍",
      from_me: true,
    });
    expect(fired("hornero_reaction")).toEqual([
      {
        clientId: "default",
        chat: ANA,
        author: ANA,
        message_id: "M",
        emoji: "👍",
        from_me: true,
      },
    ]);
  });

  it("descarta la reacción de un desconocido", () => {
    client.emit("reaction", {
      key: { remoteJid: STRANGER },
      chat: STRANGER,
      emoji: "👍",
    });
    expect(fired("hornero_reaction")).toHaveLength(0);
  });
});

describe("hornero_poll_vote", () => {
  it("respeta la allowlist del grupo", () => {
    client.emit("poll_vote", {
      key: { remoteJid: GROUP, participant: STRANGER },
      chat: GROUP,
      selected_options: ["Pizza"],
    });
    client.emit("poll_vote", {
      key: { remoteJid: "otro@g.us", participant: ANA },
      chat: "otro@g.us",
      selected_options: ["Pizza"],
    });

    // The allowed group admits every member; the other group is not allowed.
    expect(fired("hornero_poll_vote")).toEqual([
      { clientId: "default", chat: GROUP, selected_options: ["Pizza"] },
    ]);
  });
});

describe("hornero_group_update", () => {
  it("solo avisa cambios de grupos permitidos", () => {
    client.emit("group_update", {
      chat: GROUP,
      action: "add",
      participants: [],
    });
    client.emit("group_update", {
      chat: "otro@g.us",
      action: "add",
      participants: [],
    });

    expect(fired("hornero_group_update")).toEqual([
      { clientId: "default", chat: GROUP, action: "add", participants: [] },
    ]);
  });
});
