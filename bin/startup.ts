#!/usr/bin/env bun
// [[startup]] hook: runs once per herdr server start. Starts the background
// poller (which does an immediate refresh) and exits. Also seeds a commented
// config.toml the first time so users can discover the options.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { configPath, loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { hookLogger } from "../src/log";
import { clearStopRequest, ensurePoller } from "../src/poller-control";

const CONFIG_TEMPLATE = `# glab-status plugin configuration. Every key is optional.
# Changes are picked up on the next poll cycle; no restart needed.

# Background refresh period for all workspaces (seconds). Default 300.
# poll_interval_seconds = 300

# Minimum gap between event-driven refreshes of one workspace (seconds). Default 30.
# throttle_seconds = 30

# Token TTL as a multiple of the poll interval, so rows fade if the poller dies. Default 3.
# ttl_multiplier = 3

# GitLab host passed to glab as GITLAB_HOST. Default: let glab infer it from the git remote.
# host = "gitlab.example.com"

# Absolute path to glab, if it is not on PATH. Default: search PATH and Homebrew locations.
# glab_path = "/opt/homebrew/bin/glab"

# Count unresolved discussion threads (one extra API call per MR). Default true.
# count_unresolved = true

# Verbose logging to herdr's plugin log and the poller log. Default false.
# debug = false
`;

function seedConfig(log: ReturnType<typeof hookLogger>): void {
  const file = configPath();
  if (existsSync(file)) return;
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(file, CONFIG_TEMPLATE);
    log.info(`wrote default config to ${file}`);
  } catch (err) {
    log.warn(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

seedConfig(log);
// A fresh server start always gets a poller, even if one was stopped before.
clearStopRequest();
const result = ensurePoller(log);
log.debug(`poller: ${result}`);
