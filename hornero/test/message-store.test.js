import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageStore } from "../src/message-store.js";

const HOUR = 60 * 60 * 1000;
const msg = (id, extra = {}) => ({
  key: { id, remoteJid: "x@s.whatsapp.net" },
  ...extra,
});

let dir;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("MessageStore", () => {
  it("olvida los mensajes cuando vencen", () => {
    let now = 0;
    const store = new MessageStore({ now: () => now });
    store.put(msg("A"), { ttlMs: HOUR });

    expect(store.get("A")).not.toBeNull();
    now = HOUR + 1;
    expect(store.get("A")).toBeNull();
  });

  it("no guarda nada con un TTL de cero", () => {
    const store = new MessageStore();
    store.put(msg("A"), { ttlMs: 0 });
    expect(store.get("A")).toBeNull();
  });

  it("al llenarse descarta primero los mensajes comunes y conserva las encuestas", () => {
    const store = new MessageStore({ limit: 2 });
    store.put(msg("POLL"), { ttlMs: HOUR, kind: "poll" });
    store.put(msg("A"), { ttlMs: HOUR });
    store.put(msg("B"), { ttlMs: HOUR });

    expect(store.get("POLL")).not.toBeNull();
    expect(store.get("A")).toBeNull();
    expect(store.get("B")).not.toBeNull();
  });

  it("no acorta la vida de una encuesta si se vuelve a guardar", () => {
    let now = 0;
    const store = new MessageStore({ now: () => now });
    store.put(msg("POLL"), { ttlMs: 30 * 24 * HOUR, kind: "poll" });
    store.put(msg("POLL"), { ttlMs: HOUR });

    now = 2 * HOUR;
    expect(store.get("POLL")).not.toBeNull();
  });

  it("sobrevive a un reinicio, con los Buffer intactos", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hornero-store-"));
    const first = new MessageStore({ dir });
    first.put(
      msg("A", {
        message: { imageMessage: { mediaKey: Buffer.from("clave") } },
      }),
      { ttlMs: HOUR },
    );
    await first.save();

    const second = new MessageStore({ dir });
    await second.load();
    const restored = second.get("A");
    expect(Buffer.isBuffer(restored.message.imageMessage.mediaKey)).toBe(true);
    expect(restored.message.imageMessage.mediaKey.toString()).toBe("clave");
  });
});
