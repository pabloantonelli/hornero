import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import axios from "axios";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildContent,
  kindFor,
  loadSource,
  saveFile,
} from "../src/outgoing-media.js";

let base;
let readRoot;
let saveRoot;
const MB = 1e6;

beforeAll(async () => {
  base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hornero-media-")),
  );
  readRoot = path.join(base, "config");
  saveRoot = path.join(base, "config", "www", "hornero");
  await fs.mkdir(readRoot, { recursive: true });
  await fs.writeFile(path.join(readRoot, "informe.pdf"), "%PDF-1.4 fake");
  await fs.writeFile(path.join(base, "secreto.txt"), "no");
  await fs.symlink(
    path.join(base, "secreto.txt"),
    path.join(readRoot, "atajo.txt"),
  );
  process.env.HORNERO_READ_ROOTS = readRoot;
  process.env.HORNERO_SAVE_ROOTS = saveRoot;
});

afterAll(async () => {
  delete process.env.HORNERO_READ_ROOTS;
  delete process.env.HORNERO_SAVE_ROOTS;
  await fs.rm(base, { recursive: true, force: true });
});

describe("loadSource", () => {
  it("lee un archivo permitido y deduce el tipo por la extensión", async () => {
    const file = await loadSource(
      { path: path.join(readRoot, "informe.pdf") },
      { maxBytes: MB },
    );
    expect(file).toMatchObject({
      mimetype: "application/pdf",
      fileName: "informe.pdf",
    });
    expect(file.buffer.toString()).toBe("%PDF-1.4 fake");
  });

  it("rechaza rutas fuera de las carpetas permitidas, también con ..", async () => {
    await expect(
      loadSource(
        { path: path.join(readRoot, "..", "secreto.txt") },
        { maxBytes: MB },
      ),
    ).rejects.toMatchObject({ code: 403 });
  });

  it("no deja escapar por un enlace simbólico", async () => {
    await expect(
      loadSource({ path: path.join(readRoot, "atajo.txt") }, { maxBytes: MB }),
    ).rejects.toMatchObject({ code: 403 });
  });

  it("respeta el tope de tamaño", async () => {
    await expect(
      loadSource({ path: path.join(readRoot, "informe.pdf") }, { maxBytes: 5 }),
    ).rejects.toMatchObject({ code: 413 });
  });

  it("acepta base64 en una URL data: y toma su tipo", async () => {
    const file = await loadSource(
      {
        data: `data:image/png;base64,${Buffer.from("png!").toString("base64")}`,
      },
      { maxBytes: MB },
    );
    expect(file.mimetype).toBe("image/png");
    expect(file.buffer.toString()).toBe("png!");
  });

  it("rechaza base64 inválido", async () => {
    await expect(
      loadSource({ data: "no es base64!!" }, { maxBytes: MB }),
    ).rejects.toMatchObject({
      code: 400,
    });
  });

  it("descarga desde una URL y usa el tipo que informa el servidor", async () => {
    const spy = vi.spyOn(axios, "get").mockResolvedValueOnce({
      data: Buffer.from("jpeg"),
      headers: { "content-type": "image/jpeg" },
    });
    const file = await loadSource(
      { url: "https://example.com/foto" },
      { maxBytes: MB },
    );
    expect(file.mimetype).toBe("image/jpeg");
    expect(spy).toHaveBeenCalledWith(
      "https://example.com/foto",
      expect.objectContaining({ maxContentLength: MB }),
    );
    spy.mockRestore();
  });

  it("exige exactamente una fuente", async () => {
    await expect(loadSource({}, { maxBytes: MB })).rejects.toMatchObject({
      code: 400,
    });
    await expect(
      loadSource({ url: "https://x", data: "aGk=" }, { maxBytes: MB }),
    ).rejects.toMatchObject({ code: 400 });
  });
});

describe("buildContent", () => {
  it("convierte a Ogg/Opus un audio que se manda como nota de voz", async () => {
    const convert = vi.fn(async () => Buffer.from("opus"));
    const content = await buildContent(
      { buffer: Buffer.from("mp3"), mimetype: "audio/mpeg" },
      { ptt: true },
      { convert },
    );
    expect(convert).toHaveBeenCalledWith(
      Buffer.from("mp3"),
      expect.arrayContaining(["libopus", "ogg"]),
    );
    expect(content).toEqual({
      audio: Buffer.from("opus"),
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
  });

  it("no convierte un audio que ya es Ogg/Opus", async () => {
    const convert = vi.fn();
    const content = await buildContent(
      { buffer: Buffer.from("ogg"), mimetype: "audio/ogg; codecs=opus" },
      { ptt: true },
      { convert },
    );
    expect(convert).not.toHaveBeenCalled();
    expect(content.ptt).toBe(true);
  });

  it("convierte una imagen en sticker WebP", async () => {
    const convert = vi.fn(async () => Buffer.from("webp"));
    const content = await buildContent(
      { buffer: Buffer.from("png"), mimetype: "image/png" },
      { kind: "sticker" },
      { convert },
    );
    expect(content).toEqual({
      sticker: Buffer.from("webp"),
      mimetype: "image/webp",
    });
  });

  it("manda un documento con nombre y epígrafe", async () => {
    const content = await buildContent(
      {
        buffer: Buffer.from("pdf"),
        mimetype: "application/pdf",
        fileName: "a.pdf",
      },
      { caption: "El informe" },
    );
    expect(content).toEqual({
      document: Buffer.from("pdf"),
      mimetype: "application/pdf",
      fileName: "a.pdf",
      caption: "El informe",
    });
  });

  it("elige el tipo de mensaje según el mimetype", () => {
    expect(kindFor("image/jpeg")).toBe("image");
    expect(kindFor("video/mp4")).toBe("video");
    expect(kindFor("audio/mpeg")).toBe("audio");
    expect(kindFor("application/pdf")).toBe("document");
  });
});

describe("saveFile", () => {
  it("guarda dentro de la carpeta permitida, creando las subcarpetas", async () => {
    const written = await saveFile(`${saveRoot}/entrantes/`, Buffer.from("x"), {
      defaultName: "MSG1.jpg",
    });
    expect(written).toBe(path.join(saveRoot, "entrantes", "MSG1.jpg"));
    expect(await fs.readFile(written, "utf8")).toBe("x");
  });

  it("rechaza escribir fuera de las carpetas permitidas", async () => {
    await expect(
      saveFile(path.join(readRoot, "configuration.yaml"), Buffer.from("x"), {
        defaultName: "a",
      }),
    ).rejects.toMatchObject({ code: 403 });
  });
});
