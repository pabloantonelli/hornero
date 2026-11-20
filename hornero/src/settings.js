import fs from "node:fs/promises";
import path from "node:path";

/**
 * Settings that can be changed from the panel, stored in /data so a change
 * takes effect without editing the add-on options and restarting.
 *
 * The add-on options seed this on first run; afterwards the stored values win.
 */

export const DEFAULTS = {
  markRead: false,
  groupsRequireMention: false,
  typingIndicator: true,
  typingMaxSeconds: 3,
  markOnline: false,
  refreshHours: 0,
  logLevel: "info",
  mediaCacheHours: 24,
  mediaMaxMb: 20,
};

/** Changing these needs a reconnect, so the panel says so. */
export const RESTART_REQUIRED = ["markOnline", "refreshHours"];

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

const coerce = {
  markRead: Boolean,
  groupsRequireMention: Boolean,
  typingIndicator: Boolean,
  markOnline: Boolean,
  typingMaxSeconds: (v) =>
    Math.min(10, Math.max(0, Math.round(Number(v) || 0))),
  refreshHours: (v) => Math.min(48, Math.max(0, Math.round(Number(v) || 0))),
  // 0 is meaningful here (keep nothing), so only a non-number falls back.
  mediaCacheHours: (v) =>
    Number.isFinite(Number(v))
      ? Math.min(168, Math.max(0, Math.round(Number(v))))
      : DEFAULTS.mediaCacheHours,
  mediaMaxMb: (v) => Math.min(100, Math.max(1, Math.round(Number(v) || 20))),
  logLevel: (v) => (LOG_LEVELS.includes(v) ? v : DEFAULTS.logLevel),
};

export const sanitise = (input, base = DEFAULTS) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined || !(key in coerce)) continue;
    out[key] = coerce[key](value);
  }
  return out;
};

export class SettingsStore {
  #file;
  #values = { ...DEFAULTS };
  #logger;
  #onChange;

  constructor({ dataDir, logger, onChange }) {
    this.#file = path.join(dataDir, "settings.json");
    this.#logger = logger;
    this.#onChange = onChange;
  }

  async load(seed) {
    this.#values = sanitise(seed);

    try {
      const stored = JSON.parse(await fs.readFile(this.#file, "utf8"));
      this.#values = sanitise(stored, this.#values);
    } catch {
      // not saved yet; the seeded values stand
    }

    this.#onChange?.(this.#values);
  }

  get values() {
    return { ...this.#values };
  }

  get typingMaxMs() {
    return this.#values.typingMaxSeconds * 1000;
  }

  get(key) {
    return this.#values[key];
  }

  async update(patch) {
    this.#values = sanitise(patch, this.#values);

    try {
      await fs.writeFile(this.#file, JSON.stringify(this.#values, null, 2));
    } catch (err) {
      this.#logger?.error({ err: err.message }, "could not save settings");
    }

    this.#onChange?.(this.#values);
    return this.values;
  }
}
