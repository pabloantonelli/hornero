import axios from "axios";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Files sent with send_media that do not come from a camera: a file on disk,
 * a URL, or base64 data. Also the reverse — where a downloaded file may be
 * written.
 */

export class MediaError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

const roots = (variable, fallback) =>
  (process.env[variable] || fallback)
    .split(":")
    .filter(Boolean)
    .map((root) => path.resolve(root));

/** Where send_media may read files from. */
export const readRoots = () => roots("HORNERO_READ_ROOTS", "/config:/media");

/** Where download_media may write files to. */
export const saveRoots = () =>
  roots("HORNERO_SAVE_ROOTS", "/config/www/hornero:/media");

const inside = (target, root) =>
  target === root || target.startsWith(root + path.sep);

/**
 * Resolves a path and checks it stays inside one of `allowed`, following
 * symlinks, so neither `..` nor a link can reach the rest of the system.
 */
const confine = async (requested, allowed, { mustExist }) => {
  const absolute = path.resolve(String(requested));
  const root = allowed.find((r) => inside(absolute, r));
  if (!root) {
    throw new MediaError(
      `Path ${requested} is outside the allowed folders: ${allowed.join(", ")}.`,
      403,
    );
  }

  let real;
  try {
    real = mustExist
      ? await fs.realpath(absolute)
      : path.join(
          await fs.realpath(path.dirname(absolute)),
          path.basename(absolute),
        );
  } catch {
    throw new MediaError(`Path ${requested} does not exist.`, 404);
  }

  const realRoot = await fs.realpath(root).catch(() => root);
  if (!inside(real, realRoot)) {
    throw new MediaError(`Path ${requested} leads outside ${root}.`, 403);
  }
  return real;
};

const EXTENSIONS = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const MIME_EXTENSIONS = Object.fromEntries(
  Object.entries(EXTENSIONS)
    .reverse()
    .map(([ext, mime]) => [mime.split(";")[0], ext]),
);

export const mimetypeFor = (fileName) =>
  EXTENSIONS[
    path
      .extname(String(fileName ?? ""))
      .slice(1)
      .toLowerCase()
  ] ?? null;

export const extensionFor = (mimetype) =>
  MIME_EXTENSIONS[
    String(mimetype ?? "")
      .split(";")[0]
      .trim()
  ] ?? "bin";

/** The WhatsApp message kind that suits a mimetype. */
export const kindFor = (mimetype) => {
  const type = String(mimetype ?? "");
  if (type === "image/webp") return "image";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "document";
};

const tooBig = (bytes, maxBytes) =>
  new MediaError(
    `The file is ${(bytes / 1e6).toFixed(1)} MB, over the ${(maxBytes / 1e6).toFixed(0)} MB limit.`,
    413,
  );

/**
 * Reads the file to send from exactly one source. Returns its bytes, its
 * mimetype (given, or guessed from the name, the server or a data URL) and a
 * file name for documents.
 */
export const loadSource = async (
  { path: filePath, url, data, mimetype, fileName },
  { maxBytes },
) => {
  const given = [filePath, url, data].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new MediaError("Give exactly one of path, url or data.");
  }

  if (filePath !== undefined) {
    const real = await confine(filePath, readRoots(), { mustExist: true });
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new MediaError(`${filePath} is not a file.`);
    if (stat.size > maxBytes) throw tooBig(stat.size, maxBytes);
    const name = fileName ?? path.basename(real);
    return {
      buffer: await fs.readFile(real),
      mimetype: mimetype ?? mimetypeFor(name) ?? "application/octet-stream",
      fileName: name,
    };
  }

  if (url !== undefined) {
    let response;
    try {
      response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
      });
    } catch (err) {
      if (/maxContentLength/.test(err.message))
        throw tooBig(maxBytes + 1, maxBytes);
      throw new MediaError(`Could not download ${url}: ${err.message}`, 502);
    }
    const name = fileName ?? (path.basename(new URL(url).pathname) || "file");
    const served = String(response.headers?.["content-type"] ?? "").split(
      ";",
    )[0];
    return {
      buffer: Buffer.from(response.data),
      mimetype:
        mimetype ??
        mimetypeFor(name) ??
        (served && served !== "application/octet-stream" ? served : null) ??
        "application/octet-stream",
      fileName: name,
    };
  }

  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(String(data));
  const encoded = (match ? match[2] : String(data)).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded)) {
    throw new MediaError("data is not valid base64.");
  }
  if (encoded.length * 0.75 > maxBytes + 3) {
    throw tooBig(Math.floor(encoded.length * 0.75), maxBytes);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0) throw new MediaError("data is empty.");
  return {
    buffer,
    mimetype:
      mimetype ??
      match?.[1] ??
      mimetypeFor(fileName) ??
      "application/octet-stream",
    fileName: fileName ?? null,
  };
};

/** Runs ffmpeg over a buffer, from stdin to stdout. */
export const runFfmpeg = (input, args) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        ...args,
        "pipe:1",
      ]);
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errors = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (err) =>
      reject(
        err.code === "ENOENT"
          ? new MediaError(
              "ffmpeg is not installed, so the file cannot be converted.",
              500,
            )
          : err,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new MediaError(
            `ffmpeg could not convert the file: ${Buffer.concat(errors).toString().trim() || `exit ${code}`}`,
            422,
          ),
        );
    });
    child.stdin.on("error", () => {}); // ffmpeg may close stdin early on bad input
    child.stdin.end(input);
  });

const isOpusOgg = (mimetype) =>
  /^audio\/ogg/.test(mimetype) && !/codecs=(?!opus)/.test(mimetype);

/**
 * Builds the Baileys content for a file. A voice note must be Ogg/Opus and a
 * sticker WebP, or WhatsApp shows them as broken, so anything else is
 * converted first.
 */
export const buildContent = async (
  { buffer, mimetype, fileName },
  { kind, caption, ptt = false },
  { convert = runFfmpeg } = {},
) => {
  const type = kind ?? kindFor(mimetype);
  const withCaption = caption ? { caption } : {};

  switch (type) {
    case "image":
      return { image: buffer, mimetype, ...withCaption };
    case "video":
      return { video: buffer, mimetype, ...withCaption };
    case "audio": {
      if (ptt && !isOpusOgg(mimetype)) {
        const audio = await convert(buffer, [
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          "-f",
          "ogg",
        ]);
        return { audio, mimetype: "audio/ogg; codecs=opus", ptt: true };
      }
      return {
        audio: buffer,
        mimetype: ptt ? "audio/ogg; codecs=opus" : mimetype,
        ptt: Boolean(ptt),
      };
    }
    case "sticker": {
      const sticker =
        mimetype === "image/webp"
          ? buffer
          : await convert(buffer, [
              "-vf",
              "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
              "-frames:v",
              "1",
              "-c:v",
              "libwebp",
              "-f",
              "webp",
            ]);
      return { sticker, mimetype: "image/webp" };
    }
    case "document":
      return {
        document: buffer,
        mimetype,
        fileName: fileName || `file.${extensionFor(mimetype)}`,
        ...withCaption,
      };
    default:
      throw new MediaError(`Unknown kind ${type}.`);
  }
};

/**
 * Writes a downloaded file under one of the allowed folders. A path ending in
 * a slash, or naming a folder, gets a file name made from the message id.
 */
export const saveFile = async (target, buffer, { defaultName }) => {
  let requested = String(target);
  const looksLikeDir =
    requested.endsWith("/") ||
    (await fs
      .stat(requested)
      .then((s) => s.isDirectory())
      .catch(() => false));
  if (looksLikeDir) requested = path.join(requested, defaultName);

  const absolute = path.resolve(requested);
  const allowed = saveRoots();
  if (!allowed.some((root) => inside(absolute, root))) {
    throw new MediaError(
      `Path ${target} is outside the allowed folders: ${allowed.join(", ")}.`,
      403,
    );
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const real = await confine(absolute, allowed, { mustExist: false });
  await fs.writeFile(real, buffer);
  return real;
};
