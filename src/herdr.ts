import { herdrBin, SOURCE, TOKEN } from "./env";
import { runCommand, type CommandResult } from "./exec";

export interface Workspace {
  workspaceId: string;
  label: string;
  checkoutPath: string;
  /** The `$mr` token this workspace is currently showing in the sidebar
   * (see label.ts's formatLabel), read straight from `herdr workspace
   * list`'s cached state -- not re-fetched from glab. null if there is
   * none (no MR, or the token hasn't been reported/has expired). Optional
   * on the type so existing Workspace literals elsewhere (tests, mostly)
   * don't all need updating; toWorkspace() below always sets it. */
  mrToken?: string | null;
}

interface RawWorkspace {
  workspace_id?: unknown;
  label?: unknown;
  worktree?: { checkout_path?: unknown } | null;
  tokens?: { mr?: unknown } | null;
}

function toWorkspace(raw: unknown): Workspace | null {
  if (raw === null || typeof raw !== "object") return null;
  const ws = raw as RawWorkspace;
  const id = ws.workspace_id;
  const path = ws.worktree?.checkout_path;
  if (typeof id !== "string" || id === "") return null;
  // Workspaces without a checkout (no worktree) have nothing to look up.
  if (typeof path !== "string" || path === "") return null;
  const mr = ws.tokens?.mr;
  return {
    workspaceId: id,
    label: typeof ws.label === "string" ? ws.label : id,
    checkoutPath: path,
    mrToken: typeof mr === "string" && mr !== "" ? mr : null,
  };
}

// Accepts the `herdr workspace list` payload ({result:{workspaces:[...]}}),
// the `herdr workspace get` payload ({result:{workspace:{...}}}), or a bare
// array. Workspaces without `worktree.checkout_path` are skipped.
export function parseWorkspaces(payload: unknown): Workspace[] {
  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (payload && typeof payload === "object") {
    const result = (payload as { result?: unknown }).result;
    const container = result && typeof result === "object" ? (result as Record<string, unknown>) : (payload as Record<string, unknown>);
    if (Array.isArray(container.workspaces)) items = container.workspaces;
    else if (container.workspace && typeof container.workspace === "object") items = [container.workspace];
  }
  const out: Workspace[] = [];
  for (const item of items) {
    const ws = toWorkspace(item);
    if (ws) out.push(ws);
  }
  return out;
}

export function runHerdr(args: string[]): Promise<CommandResult> {
  return runCommand([herdrBin(), ...args], { timeoutMs: 20_000 });
}

// All workspaces with a checkout, or null when herdr itself is unreachable.
export async function listWorkspaces(): Promise<Workspace[] | null> {
  const result = await runHerdr(["workspace", "list"]);
  if (!result.ok) return null;
  try {
    return parseWorkspaces(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

// One workspace with a checkout, or null if unreachable / no checkout.
export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const result = await runHerdr(["workspace", "get", workspaceId]);
  if (!result.ok) return null;
  try {
    return parseWorkspaces(JSON.parse(result.stdout))[0] ?? null;
  } catch {
    return null;
  }
}

export function reportToken(workspaceId: string, label: string, ttlMs: number, seq: number): Promise<CommandResult> {
  return runHerdr([
    "workspace",
    "report-metadata",
    workspaceId,
    "--source",
    SOURCE,
    "--token",
    `${TOKEN}=${label}`,
    "--ttl-ms",
    String(ttlMs),
    "--seq",
    String(seq),
  ]);
}

export function clearToken(workspaceId: string, seq: number): Promise<CommandResult> {
  return runHerdr([
    "workspace",
    "report-metadata",
    workspaceId,
    "--source",
    SOURCE,
    "--clear-token",
    TOKEN,
    "--seq",
    String(seq),
  ]);
}

export async function showNotification(title: string, body: string): Promise<void> {
  await runHerdr(["notification", "show", title, "--body", body]);
}
