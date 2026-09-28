import { beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(
  path.join(import.meta.dirname, "../src/public/index.html"),
  "utf8",
);

/** Boots the panel in jsdom with the network stubbed out. */
const boot = async (language = "en", routes = null) => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    pretendToBeVisual: true,
    // Must be in place before the panel script runs.
    beforeParse(win) {
      Object.defineProperty(win.navigator, "languages", {
        value: [language],
        configurable: true,
      });
      win.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      // The panel polls on load; keep it offline and deterministic, except
      // for the routes a test asks to answer.
      win.fetch = (url) => {
        const hit =
          routes &&
          Object.entries(routes).find(([path]) => String(url).includes(path));
        return hit
          ? Promise.resolve({ ok: true, json: async () => hit[1] })
          : Promise.reject(new Error("offline"));
      };
      win.document.execCommand = vi.fn(() => true);
    },
  });

  const { window } = dom;

  await new Promise((resolve) => window.addEventListener("load", resolve));
  return window;
};

describe("panel: copy buttons", () => {
  let window;

  beforeEach(async () => {
    window = await boot();
  });

  it("each block copies its own snippet, not the first one", async () => {
    const heads = [...window.document.querySelectorAll("#b-output .out-head")];
    const pres = [...window.document.querySelectorAll("#b-output pre")];

    // The default action renders Home Assistant, two Node-RED blocks and curl.
    expect(heads.length).toBeGreaterThan(1);
    expect(pres.length).toBe(heads.length);

    const copied = [];
    window.navigator.clipboard = {
      writeText: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    };
    Object.defineProperty(window, "isSecureContext", { value: true });

    for (const head of heads) {
      head.querySelector("button[data-act='copy-text']").click();
      await new Promise((r) => window.setTimeout(r, 0));
    }

    expect(copied).toEqual(pres.map((p) => p.textContent));
    // The bug being guarded against: every button copying the first block.
    expect(new Set(copied).size).toBe(copied.length);
  });

  it("falls back to execCommand when clipboard is unavailable", async () => {
    // Ingress is served over plain HTTP, where navigator.clipboard is absent.
    Object.defineProperty(window, "isSecureContext", { value: false });
    window.navigator.clipboard = undefined;

    const btn = window.document.querySelector(
      "#b-output button[data-act='copy-text']",
    );
    btn.click();
    await new Promise((r) => window.setTimeout(r, 0));

    expect(window.document.execCommand).toHaveBeenCalledWith("copy");
    expect(btn.textContent).toBe("Copied");
  });
});

describe("panel: snippet builder", () => {
  it("renders Home Assistant, Node-RED and curl for a service call", async () => {
    const window = await boot();
    const titles = [
      ...window.document.querySelectorAll("#b-output .section-label"),
    ].map((el) => el.textContent);

    expect(titles).toEqual([
      "Home Assistant",
      "Node-RED — fill in by hand",
      "Node-RED — import",
      "curl",
    ]);
  });

  it("tiene las siete pestañas", async () => {
    const window = await boot();
    const tabs = [...window.document.querySelectorAll("nav button")].map(
      (b) => b.dataset.tab,
    );

    expect(tabs).toEqual([
      "status",
      "send",
      "chats",
      "messages",
      "builder",
      "settings",
      "help",
    ]);
  });

  it("cambiar de pestaña muestra sólo ese panel", async () => {
    const window = await boot();
    window.document.querySelector('nav button[data-tab="help"]').click();

    const visible = [...window.document.querySelectorAll("[data-panel]")]
      .filter((p) => !p.hidden)
      .map((p) => p.dataset.panel);

    expect(visible).toEqual(["help"]);
  });

  it("switches to event listeners without curl", async () => {
    const window = await boot();
    const select = window.document.getElementById("b-action");
    select.value = "listen-message";
    select.dispatchEvent(new window.Event("change"));

    const out = window.document.getElementById("b-output").textContent;
    expect(out).toContain("hornero_message");
    expect(out).toContain("server-events");
    expect(out).not.toContain("curl");
  });
});

/** A tab is an icon plus a labelled span; the label is what the user reads. */
const tabLabels = (window) =>
  [...window.document.querySelectorAll("nav button span")].map(
    (s) => s.textContent,
  );

describe("panel: enviar", () => {
  it("ofrece destinatario, mensaje y envío de una cámara", async () => {
    const window = await boot();
    const panel = window.document.querySelector('[data-panel="send"]');

    expect(panel).not.toBeNull();
    for (const id of ["send-client", "send-to", "send-text", "send-go"]) {
      expect(panel.querySelector("#" + id)).not.toBeNull();
    }
    // The camera fields stay out of the way until asked for.
    expect(window.document.getElementById("send-camera-row").hidden).toBe(true);
    window.document.getElementById("send-snapshot").click();
    expect(window.document.getElementById("send-camera-row").hidden).toBe(
      false,
    );
  });
});

describe("panel: ajustes", () => {
  it("traduce cada ajuste en vez de mostrar su clave", async () => {
    const window = await boot("es", {
      "/settings": {
        settings: {
          markRead: false,
          groupsRequireMention: true,
          typingIndicator: true,
          typingMaxSeconds: 3,
          markOnline: false,
          refreshHours: 0,
          logLevel: "info",
        },
        restartRequired: ["markOnline"],
      },
    });
    window.document.querySelector('nav button[data-tab="settings"]').click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const labels = [
      ...window.document.querySelectorAll("#settings-form label"),
    ].map((l) => l.textContent.trim());

    expect(labels).toContain("Marcar como leídos los mensajes entrantes");
    expect(labels.some((l) => l.startsWith("set_"))).toBe(false);
  });
});

describe("panel: idiomas", () => {
  it("traduce la interfaz al idioma del navegador", async () => {
    const window = await boot("es");
    const tabs = tabLabels(window);

    expect(tabs).toContain("Ajustes");
    expect(tabs).toContain("Enviar");
  });

  it("acepta una variante regional y cae al idioma base", async () => {
    const window = await boot("de-AT");
    expect(tabLabels(window)).toContain("Einstellungen");
  });

  it("vuelve al inglés con un idioma que no soportamos", async () => {
    const window = await boot("ja");
    expect(tabLabels(window)).toContain("Settings");
  });
});
