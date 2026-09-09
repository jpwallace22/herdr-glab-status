#!/usr/bin/env bun
// `pick-mr` action entrypoint: opens the "picker" plugin pane declared in
// herdr-plugin.toml, which is where bin/pick-mr.ts's interactive fzf UI
// actually runs. An action's own command has no real terminal (fzf needs
// one); a plugin pane does, the same way sessionizer opens its picker.

import { runHerdr } from "../src/herdr";

const result = await runHerdr(["plugin", "pane", "open", "--plugin", "glab-status", "--entrypoint", "picker"]);
if (!result.ok) {
  const detail = result.spawnError ?? (result.stderr.trim() || `exit ${result.exitCode}`);
  console.error(`[glab-status] could not open the pick-mr pane: ${detail}`);
  process.exitCode = 1;
}
