import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSupportedBrowser, SUPPORTED_BROWSERS, type SupportedBrowser } from "./browser";
import { configDir } from "./env";

export interface Config {
  /** Background poll period for refreshing every workspace. */
  pollIntervalMs: number;
  /** Minimum gap between event-driven refreshes of a single workspace. */
  throttleMs: number;
  /** Token TTL = pollIntervalMs * ttlMultiplier, so a dead poller fades out. */
  ttlMultiplier: number;
  /** Optional GitLab host override, exported to glab as GITLAB_HOST. */
  host: string | null;
  /** Optional absolute path to the glab binary. */
  glabPath: string | null;
  /** Count unresolved discussion threads (one extra API call per MR). */
  countUnresolved: boolean;
  /** `open-mr`: force this Chrome-family app instead of auto-detecting the first one already running. macOS only. */
  browser: SupportedBrowser | null;
  /** `open-mr`: focus an already-open tab for the MR instead of always opening a new one. macOS + a supported browser only. */
  reuseTab: boolean;
  /** Verbose logging. */
  debug: boolean;
}

export const DEFAULT_CONFIG: Readonly<Config> = {
  pollIntervalMs: 5 * 60_000,
  throttleMs: 30_000,
  ttlMultiplier: 3,
  host: null,
  glabPath: null,
  countUnresolved: true,
  browser: null,
  reuseTab: true,
  debug: false,
};

export const CONFIG_FILE = "config.toml";
export const MIN_POLL_INTERVAL_MS = 15_000;
// herdr rejects --ttl-ms outside 1..86400000.
export const MAX_TTL_MS = 86_400_000;

type Warn = (message: string) => void;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Pure: turn a parsed TOML document into a Config, falling back to defaults
// (with a warning) for anything malformed. Never throws.
export function parseConfig(raw: unknown, warn: Warn = () => {}): Config {
  const cfg: Config = { ...DEFAULT_CONFIG };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warn("config.toml is not a table; using defaults");
    return cfg;
  }
  const r = raw as Record<string, unknown>;

  if (r.poll_interval_seconds !== undefined) {
    const seconds = finiteNumber(r.poll_interval_seconds);
    if (seconds === null || seconds <= 0) {
      warn("poll_interval_seconds must be a positive number; using default");
    } else if (seconds * 1000 < MIN_POLL_INTERVAL_MS) {
      warn(`poll_interval_seconds below ${MIN_POLL_INTERVAL_MS / 1000}s; clamping`);
      cfg.pollIntervalMs = MIN_POLL_INTERVAL_MS;
    } else {
      cfg.pollIntervalMs = Math.round(seconds * 1000);
    }
  }

  if (r.throttle_seconds !== undefined) {
    const seconds = finiteNumber(r.throttle_seconds);
    if (seconds === null || seconds < 0) {
      warn("throttle_seconds must be a non-negative number; using default");
    } else {
      cfg.throttleMs = Math.round(seconds * 1000);
    }
  }

  if (r.ttl_multiplier !== undefined) {
    const mult = finiteNumber(r.ttl_multiplier);
    if (mult === null || mult < 1) {
      warn("ttl_multiplier must be a number >= 1; using default");
    } else {
      cfg.ttlMultiplier = mult;
    }
  }

  if (r.host !== undefined) {
    const host = nonEmptyString(r.host);
    if (host === null) warn("host must be a non-empty string; ignoring");
    else cfg.host = host;
  }

  if (r.glab_path !== undefined) {
    const path = nonEmptyString(r.glab_path);
    if (path === null) warn("glab_path must be a non-empty string; ignoring");
    else cfg.glabPath = path;
  }

  if (r.count_unresolved !== undefined) {
    if (typeof r.count_unresolved !== "boolean") warn("count_unresolved must be a boolean; ignoring");
    else cfg.countUnresolved = r.count_unresolved;
  }

  if (r.browser !== undefined) {
    const value = nonEmptyString(r.browser);
    if (value === null || !isSupportedBrowser(value)) {
      warn(`browser must be one of ${SUPPORTED_BROWSERS.join(", ")}; ignoring`);
    } else {
      cfg.browser = value;
    }
  }

  if (r.reuse_tab !== undefined) {
    if (typeof r.reuse_tab !== "boolean") warn("reuse_tab must be a boolean; ignoring");
    else cfg.reuseTab = r.reuse_tab;
  }

  if (r.debug !== undefined) {
    if (typeof r.debug !== "boolean") warn("debug must be a boolean; ignoring");
    else cfg.debug = r.debug;
  }

  return cfg;
}

export function configPath(dir: string = configDir()): string {
  return join(dir, CONFIG_FILE);
}

// Read `<config dir>/config.toml`. Missing or unreadable files yield defaults.
export function loadConfig(dir: string = configDir(), warn: Warn = () => {}): Config {
  const file = configPath(dir);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const text = readFileSync(file, "utf8");
    // Bun ships a native TOML parser; typed loosely for older type packages.
    const parsed = (Bun as unknown as { TOML: { parse(s: string): unknown } }).TOML.parse(text);
    return parseConfig(parsed, warn);
  } catch (err) {
    warn(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}; using defaults`);
    return { ...DEFAULT_CONFIG };
  }
}

// TTL reported with each token. ~3x the poll interval by default, clamped to
// herdr's accepted range.
export function tokenTtlMs(cfg: Pick<Config, "pollIntervalMs" | "ttlMultiplier">): number {
  const ttl = Math.round(cfg.pollIntervalMs * cfg.ttlMultiplier);
  return Math.min(MAX_TTL_MS, Math.max(1, ttl));
}
