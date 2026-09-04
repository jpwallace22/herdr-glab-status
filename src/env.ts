import { tmpdir } from "node:os";
import { join } from "node:path";

// Plugin identity. The token name is what users render as `$mr` in
// `[ui.sidebar.spaces]`; the source scopes `--seq` ordering in herdr.
export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? "glab-status";
export const SOURCE = "glab-status";
export const TOKEN = "mr";
export const LOG_PREFIX = `[${PLUGIN_ID}]`;

// Herdr injects these for hooks and actions. The fallbacks only matter when a
// script is run by hand outside herdr (e.g. `bun bin/update.ts` for debugging).
export function pluginRoot(): string {
  return process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, "..");
}

export function stateDir(): string {
  return process.env.HERDR_PLUGIN_STATE_DIR ?? join(tmpdir(), "herdr-glab-status", "state");
}

export function configDir(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(tmpdir(), "herdr-glab-status", "config");
}

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}

export function herdrSocketPath(): string | null {
  return process.env.HERDR_SOCKET_PATH ?? null;
}
