import { existsSync } from "node:fs";
import type { Config } from "./config";
import { runCommand, type CommandResult } from "./exec";
import { normalizeBranch } from "./resolve";

// How a failed glab call should be treated.
//   no_mr   → the branch has no MR (or its remote isn't GitLab at all): clear
//             the token, carry on
//   auth    → glab cannot authenticate: log once, clear every token, stop
//   missing → glab binary not found: same as auth
//   other   → transient (network, timeout, unexpected glab error): keep the
//             existing token in place, carry on
export type GlabFailure = "no_mr" | "auth" | "missing" | "other";

const NO_MR_PATTERN =
  /no open merge request|merge request not found|\b404\b|none of the git remotes|not a known gitlab host/i;
const AUTH_PATTERN =
  /\b401\b|unauthori[sz]ed|not (?:logged in|authenticated)|glab auth login|no token|invalid token|token (?:has )?expired|authentication required/i;

export function classifyFailure(result: CommandResult): GlabFailure {
  if (result.spawnError) return "missing";
  const text = `${result.stderr}\n${result.stdout}`;
  if (NO_MR_PATTERN.test(text)) return "no_mr";
  if (AUTH_PATTERN.test(text)) return "auth";
  return "other";
}

// First non-empty line of stderr, for log messages.
export function briefError(result: CommandResult): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return "timed out";
  const line = result.stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !/^error$/i.test(l));
  return line ?? `exit ${result.exitCode}`;
}

const FALLBACK_GLAB_PATHS = [
  "/opt/homebrew/bin/glab",
  "/usr/local/bin/glab",
  "/home/linuxbrew/.linuxbrew/bin/glab",
];

// herdr hooks may run with a slimmer PATH than an interactive shell, so look in
// the usual Homebrew locations before giving up.
export function resolveGlabPath(cfg: Pick<Config, "glabPath">): string {
  if (cfg.glabPath) return cfg.glabPath;
  const onPath = Bun.which("glab");
  if (onPath) return onPath;
  for (const candidate of FALLBACK_GLAB_PATHS) if (existsSync(candidate)) return candidate;
  return "glab";
}

export interface GlabClient {
  /** Current branch of the checkout, or null for detached HEAD / not a repo. */
  currentBranch(cwd: string): Promise<string | null>;
  /** `glab mr view <ref> --output json`, run inside the checkout. */
  mrView(ref: string, cwd: string): Promise<CommandResult>;
  /** One page of the MR discussions API. */
  discussionsPage(
    projectId: number | null,
    iid: number,
    page: number,
    perPage: number,
    cwd: string,
  ): Promise<CommandResult>;
}

// Without this, a dead network turns each `glab` call into glab's own ~42s
// HTTP timeout, so a poll cycle over N workspaces can take N x 42s instead of
// failing fast into a "keep" decision.
const GLAB_CALL_TIMEOUT_MS = 20_000;

export function createGlabClient(cfg: Config): GlabClient {
  const glab = resolveGlabPath(cfg);
  const git = Bun.which("git") ?? "git";
  const env: Record<string, string> = { NO_COLOR: "1" };
  if (cfg.host) env.GITLAB_HOST = cfg.host;

  return {
    async currentBranch(cwd) {
      const result = await runCommand([git, "-C", cwd, "branch", "--show-current"], { timeoutMs: 15_000 });
      if (!result.ok) return null;
      return normalizeBranch(result.stdout);
    },
    mrView(ref, cwd) {
      return runCommand([glab, "mr", "view", ref, "--output", "json"], { cwd, env, timeoutMs: GLAB_CALL_TIMEOUT_MS });
    },
    discussionsPage(projectId, iid, page, perPage, cwd) {
      const project = projectId === null ? ":id" : String(projectId);
      const endpoint = `projects/${project}/merge_requests/${iid}/discussions?per_page=${perPage}&page=${page}`;
      return runCommand([glab, "api", endpoint], { cwd, env, timeoutMs: GLAB_CALL_TIMEOUT_MS });
    },
  };
}
