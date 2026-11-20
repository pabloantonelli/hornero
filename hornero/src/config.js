import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const VERSION = pkg.version;
export const BAILEYS_VERSION = pkg.dependencies.baileys;

const DATA_DIR = process.env.HORNERO_DATA_DIR || "/data";
const OPTIONS_FILE = path.join(DATA_DIR, "options.json");
const TOKEN_FILE = path.join(DATA_DIR, "token");

/**
 * The add-on token authenticates the HTTP API. It comes from the add-on
 * options, and when left empty one is generated and persisted on first boot so
 * the API is never unauthenticated by accident.
 */
const resolveToken = async (configured) => {
  if (configured) return configured;

  try {
    const stored = (await fs.readFile(TOKEN_FILE, "utf8")).trim();
    if (stored) return stored;
  } catch {
    // no token stored yet
  }

  const token = crypto.randomBytes(24).toString("hex");
  await fs.writeFile(TOKEN_FILE, token, { mode: 0o600 });
  return token;
};

export const loadConfig = async () => {
  const raw = await fs.readFile(OPTIONS_FILE, "utf8");
  const options = JSON.parse(raw);

  const clients = Array.isArray(options.clients) ? options.clients : [];
  if (clients.length === 0) {
    throw new Error(
      "No clients configured. Set at least one in the add-on options.",
    );
  }

  return {
    clients,
    dataDir: DATA_DIR,
    port: Number(process.env.PORT) || 3000,
    token: await resolveToken(options.api_token),
    // Seeds the editable allowlist on first run; empty allows every sender.
    allowedSenders: options.allowed_senders ?? [],
    // Seeds the editable settings on first run; the panel owns them after that.
    settingsSeed: {
      logLevel: options.log_level,
      refreshHours: options.refresh_hours,
      markOnline: options.mark_online,
      markRead: options.mark_read,
      typingIndicator: options.typing_indicator,
      typingMaxSeconds: options.typing_max_seconds,
      mediaCacheHours: options.media_cache_hours,
      mediaMaxMb: options.media_max_mb,
    },
  };
};
