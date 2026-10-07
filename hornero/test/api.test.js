import { describe, expect, it, beforeEach, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";

vi.mock("../src/media.js", () => ({
  captureSnapshot: vi.fn(async () => ({
    buffer: Buffer.from("fake-jpeg"),
    mimetype: "image/jpeg",
    name: "Front door",
  })),
  captureRecording: vi.fn(async () => ({
    buffer: Buffer.from("fake-mp4"),
    mimetype: "video/mp4",
  })),
  toMessageContent: vi.fn(({ buffer, mimetype }, caption) => ({
    [mimetype.startsWith("video/") ? "video" : "image"]: buffer,
    mimetype,
    ...(caption ? { caption } : {}),
  })),
}));

import { captureRecording, captureSnapshot } from "../src/media.js";

const TOKEN = "test-token";

const makeClient = (overrides = {}) => ({
  status: {
    connected: true,
    disconnected: false,
    reconnecting: false,
    phone: "5491100000000",
  },
  qr: null,
  sendMessage: vi.fn(async () => ({
    key: { id: "3EB0ABC", remoteJid: "5491111111111@s.whatsapp.net" },
    messageTimestamp: 1737400000,
  })),
  updateProfileStatus: vi.fn(async () => {}),
  presenceSubscribe: vi.fn(async () => {}),
  sendPresenceUpdate: vi.fn(async () => {}),
  setSendPresenceUpdateInterval: vi.fn(),
  checkNumber: vi.fn(async () => ({ jid: "x@s.whatsapp.net", exists: true })),
  fetchGroups: vi.fn(async () => [
    { id: "120363000@g.us", name: "Familia", participants: 5, announce: false },
  ]),
  contacts: [{ id: "5491111111111@s.whatsapp.net", name: "Ana" }],
  fetchAvatarUrl: vi.fn(async () => null),
  resolveName: vi.fn((jid) =>
    jid === "5491111111111@s.whatsapp.net" ? "Ana" : null,
  ),
  requestPairingCode: vi.fn(async () => "ABCD1234"),
  markRead: vi.fn(async (keys) => keys.length),
  toJid: (phone) => `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`,
  restart: vi.fn(async () => {}),
  emit: vi.fn(),
  ...overrides,
});

let client;
let app;
let allowlist;

beforeEach(() => {
  client = makeClient();
  allowlist = {
    entries: ["5491111111111@s.whatsapp.net"],
    open: false,
    replace: vi.fn(async (entries) => {
      allowlist.entries = entries.map((e) => `${e}@s.whatsapp.net`);
      return allowlist.entries;
    }),
  };
  app = createApp({
    clients: { default: client },
    token: TOKEN,
    logger: pino({ level: "silent" }),
    allowlist,
    settings: {
      values: { markRead: false, typingIndicator: true, typingMaxSeconds: 3 },
      update: vi.fn(async (patch) => ({
        markRead: false,
        typingIndicator: true,
        typingMaxSeconds: 3,
        ...patch,
      })),
    },
    messageLog: {
      entries: [
        {
          direction: "out",
          clientId: "default",
          jid: "5491111111111@s.whatsapp.net",
          messageId: "ABC",
          preview: "hola",
          status: "delivered",
          at: "2026-09-25T00:00:00.000Z",
        },
      ],
    },
    recentSenders: {
      entries: [
        {
          id: "173478124720340@lid",
          ids: ["173478124720340@lid", "5491111111111@s.whatsapp.net"],
          name: "Ana",
          group: false,
          allowed: false,
          at: "2026-09-24T00:00:00.000Z",
        },
      ],
    },
  });
});

describe("API v1", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("rechaza peticiones sin token", async () => {
    const res = await request(app).get("/api/v1/clients");
    expect(res.status).toBe(401);
  });

  it("acepta peticiones de ingress sin token", async () => {
    const res = await request(app)
      .get("/api/v1/clients")
      .set("X-Ingress-Path", "/api/hassio_ingress/x");
    expect(res.status).toBe(200);
  });

  it("devuelve el messageId al enviar", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/messages"),
    ).send({
      to: "5491111111111",
      body: { text: "hola" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      messageId: "3EB0ABC",
      to: "5491111111111@s.whatsapp.net",
      timestamp: 1737400000,
    });
  });

  it("valida el cuerpo y explica el fallo", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/messages"),
    ).send({ to: "549111" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details[0].path).toBe("body");
  });

  it("expone el estado de los clientes", async () => {
    const res = await auth(request(app).get("/api/v1/clients"));

    expect(res.status).toBe(200);
    expect(res.body.clients[0]).toMatchObject({
      clientId: "default",
      connected: true,
    });
  });

  it("entrega un código de emparejamiento", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/pairing-code"),
    ).send({
      phone: "5491111111111",
    });

    expect(res.body).toEqual({ code: "ABCD1234" });
  });
});

describe("/health", () => {
  it("refleja el estado real de conexión", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    // El bug de v2.x: siempre informaba connected:false.
    expect(res.body.clients.default.connected).toBe(true);
    // La versión sale del package.json, no se fija aquí.
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("media", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("envía un snapshot de una cámara", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/media"),
    ).send({
      to: "5491111111111",
      entityId: "camera.front_door",
      caption: "Mirá",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      messageId: "3EB0ABC",
      mimetype: "image/jpeg",
    });
    expect(captureSnapshot).toHaveBeenCalledWith("camera.front_door");
    expect(client.sendMessage).toHaveBeenCalledWith(
      "5491111111111",
      expect.objectContaining({ mimetype: "image/jpeg", caption: "Mirá" }),
      undefined,
      { typing: undefined },
    );
  });

  it("graba un video cuando se indica duración", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/media"),
    ).send({
      to: "5491111111111",
      entityId: "camera.front_door",
      duration: 10,
      lookback: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe("video/mp4");
    expect(captureRecording).toHaveBeenCalledWith("camera.front_door", {
      duration: 10,
      lookback: 5,
    });
  });

  it("rechaza duraciones fuera de rango", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/media"),
    ).send({ to: "549111", entityId: "camera.x", duration: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });
});

describe("chats", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("lista grupos con su JID y contactos", async () => {
    const res = await auth(request(app).get("/api/v1/clients/default/chats"));

    expect(res.status).toBe(200);
    // El JID de un grupo no se puede deducir de un teléfono: es el único modo.
    expect(res.body.groups[0]).toEqual({
      id: "120363000@g.us",
      name: "Familia",
      participants: 5,
      announce: false,
    });
    expect(res.body.contacts[0].name).toBe("Ana");
  });

  it("exige token", async () => {
    const res = await request(app).get("/api/v1/clients/default/chats");
    expect(res.status).toBe(401);
  });
});

describe("datos de conexión para los snippets", () => {
  it("se sirven por ingress", async () => {
    const res = await request(app)
      .get("/api/v1/connection")
      .set("X-Ingress-Path", "/api/hassio_ingress/x");

    expect(res.status).toBe(200);
    expect(res.body.token).toBe(TOKEN);
  });

  it("no se sirven con token, sólo por ingress", async () => {
    const res = await request(app)
      .get("/api/v1/connection")
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(403);
  });
});

describe("avatares", () => {
  it("devuelve 404 cuando el chat no tiene foto", async () => {
    const res = await request(app)
      .get("/api/v1/clients/default/avatar/123@s.whatsapp.net")
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(404);
    expect(client.fetchAvatarUrl).toHaveBeenCalledWith("123@s.whatsapp.net");
  });
});

describe("indicador de escritura", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("se puede desactivar por llamada, para alertas urgentes", async () => {
    await auth(request(app).post("/api/v1/clients/default/messages")).send({
      to: "5491111111111",
      body: { text: "Fuga de agua" },
      typing: false,
    });

    expect(client.sendMessage).toHaveBeenCalledWith(
      "5491111111111",
      { text: "Fuga de agua" },
      undefined,
      { typing: false },
    );
  });
});

describe("allowlist", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("devuelve las entradas actuales", async () => {
    const res = await auth(request(app).get("/api/v1/allowlist"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entries: ["5491111111111@s.whatsapp.net"],
      open: false,
    });
  });

  it("reemplaza la lista completa", async () => {
    const res = await auth(request(app).put("/api/v1/allowlist")).send({
      entries: ["5492222222222"],
    });

    expect(res.status).toBe(200);
    expect(allowlist.replace).toHaveBeenCalledWith(["5492222222222"]);
  });

  it("acepta y devuelve el modo de cada grupo", async () => {
    allowlist.groupModes = {};
    allowlist.replace.mockImplementation(async (entries, groupModes) => {
      allowlist.entries = entries;
      allowlist.groupModes = groupModes;
    });

    const res = await auth(request(app).put("/api/v1/allowlist")).send({
      entries: ["120363000@g.us"],
      groupModes: { "120363000@g.us": "members" },
    });

    expect(res.status).toBe(200);
    expect(allowlist.replace).toHaveBeenCalledWith(["120363000@g.us"], {
      "120363000@g.us": "members",
    });
    expect(res.body.groupModes).toEqual({ "120363000@g.us": "members" });
    expect(res.body.details[0]).toMatchObject({ mode: "members" });
  });

  it("rechaza un modo de grupo desconocido", async () => {
    const res = await auth(request(app).put("/api/v1/allowlist")).send({
      entries: ["120363000@g.us"],
      groupModes: { "120363000@g.us": "algunos" },
    });

    expect(res.status).toBe(400);
  });

  it("rechaza un cuerpo que no sea una lista", async () => {
    const res = await auth(request(app).put("/api/v1/allowlist")).send({
      entries: "5492222222222",
    });

    expect(res.status).toBe(400);
  });
});

describe("remitentes recientes", () => {
  it("los expone para poder permitirlos desde el panel", async () => {
    const res = await request(app)
      .get("/api/v1/recent-senders")
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.senders[0]).toMatchObject({
      id: "173478124720340@lid",
      name: "Ana",
      allowed: false,
    });
  });
});

describe("marcar como leído", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("acepta la key completa del evento", async () => {
    const key = { id: "3EB0ABC", remoteJid: "5491111111111@s.whatsapp.net" };
    const res = await auth(
      request(app).post("/api/v1/clients/default/read"),
    ).send({ keys: [key] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ marked: 1 });
    expect(client.markRead).toHaveBeenCalledWith([key]);
  });

  it("acepta messageId y destinatario sueltos", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/read"),
    ).send({ messageId: "3EB0ABC", to: "5491111111111" });

    expect(res.status).toBe(200);
    expect(client.markRead).toHaveBeenCalledWith([
      { id: "3EB0ABC", remoteJid: "5491111111111@s.whatsapp.net" },
    ]);
  });

  it("explica qué falta si no se identifica el mensaje", async () => {
    const res = await auth(
      request(app).post("/api/v1/clients/default/read"),
    ).send({ messageId: "3EB0ABC" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("messageId and to");
  });
});

describe("ajustes desde el panel", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("devuelve los valores y cuáles requieren reinicio", async () => {
    const res = await auth(request(app).get("/api/v1/settings"));

    expect(res.status).toBe(200);
    expect(res.body.settings.typingMaxSeconds).toBe(3);
    expect(res.body.restartRequired).toContain("markOnline");
  });

  it("actualiza una sola clave", async () => {
    const res = await auth(request(app).put("/api/v1/settings")).send({
      markRead: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.settings.markRead).toBe(true);
  });

  it("rechaza valores fuera de rango", async () => {
    const res = await auth(request(app).put("/api/v1/settings")).send({
      typingMaxSeconds: 99,
    });

    expect(res.status).toBe(400);
  });
});

describe("registro de mensajes", () => {
  it("expone lo enviado con su estado de entrega", async () => {
    const res = await request(app)
      .get("/api/v1/messages")
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({
      direction: "out",
      preview: "hola",
      status: "delivered",
    });
  });

  it("exige token", async () => {
    const res = await request(app).get("/api/v1/messages");
    expect(res.status).toBe(401);
  });
});

describe("nombres de la lista de permitidos", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

  it("resuelve el nombre del contacto, para nombrar las entidades notify", async () => {
    const res = await auth(request(app).get("/api/v1/allowlist"));

    expect(res.body.details).toEqual([
      { id: "5491111111111@s.whatsapp.net", name: "Ana" },
    ]);
  });

  it("cae al nombre que reportó WhatsApp en un mensaje reciente", async () => {
    allowlist.entries = ["173478124720340@lid"];

    const res = await auth(request(app).get("/api/v1/allowlist"));
    expect(res.body.details[0].name).toBe("Ana");
  });

  it("devuelve null cuando no hay nombre conocido", async () => {
    allowlist.entries = ["120363999@g.us"];

    const res = await auth(request(app).get("/api/v1/allowlist"));
    expect(res.body.details[0].name).toBeNull();
  });
});
