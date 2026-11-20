import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, SettingsStore, sanitise } from "../src/settings.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wa-settings-"));

describe("sanitise", () => {
  it("rellena con los valores por defecto", () => {
    expect(sanitise({})).toEqual(DEFAULTS);
  });

  it("recorta los números fuera de rango", () => {
    expect(sanitise({ typingMaxSeconds: 99 }).typingMaxSeconds).toBe(10);
    expect(sanitise({ refreshHours: -5 }).refreshHours).toBe(0);
  });

  it("descarta un nivel de log inválido", () => {
    expect(sanitise({ logLevel: "loud" }).logLevel).toBe("info");
    expect(sanitise({ logLevel: "debug" }).logLevel).toBe("debug");
  });

  it("respeta 0 horas de caché de media, y acota los dos valores", () => {
    expect(sanitise({ mediaCacheHours: 0 }).mediaCacheHours).toBe(0);
    expect(sanitise({ mediaCacheHours: "x" }).mediaCacheHours).toBe(24);
    expect(sanitise({ mediaCacheHours: 1000 }).mediaCacheHours).toBe(168);
    expect(sanitise({ mediaMaxMb: 0 }).mediaMaxMb).toBe(20);
    expect(sanitise({ mediaMaxMb: 500 }).mediaMaxMb).toBe(100);
  });

  it("ignora claves desconocidas", () => {
    expect(sanitise({ nope: true })).toEqual(DEFAULTS);
  });
});

describe("SettingsStore", () => {
  it("se siembra con las opciones del add-on", async () => {
    const store = new SettingsStore({ dataDir: tmp() });
    await store.load({ markRead: true, typingMaxSeconds: 5 });

    expect(store.get("markRead")).toBe(true);
    expect(store.typingMaxMs).toBe(5000);
  });

  it("los valores guardados ganan sobre las opciones", async () => {
    const dir = tmp();
    const first = new SettingsStore({ dataDir: dir });
    await first.load({ markRead: false });
    await first.update({ markRead: true });

    const second = new SettingsStore({ dataDir: dir });
    await second.load({ markRead: false });

    expect(second.get("markRead")).toBe(true);
  });

  it("actualiza sólo las claves enviadas", async () => {
    const store = new SettingsStore({ dataDir: tmp() });
    await store.load({ typingMaxSeconds: 7, markRead: true });
    await store.update({ typingMaxSeconds: 2 });

    expect(store.get("typingMaxSeconds")).toBe(2);
    expect(store.get("markRead")).toBe(true);
  });

  it("avisa de cada cambio, para aplicar el nivel de log", async () => {
    const seen = [];
    const store = new SettingsStore({
      dataDir: tmp(),
      onChange: (v) => seen.push(v.logLevel),
    });
    await store.load({ logLevel: "warn" });
    await store.update({ logLevel: "debug" });

    expect(seen).toEqual(["warn", "debug"]);
  });
});
