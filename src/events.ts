// Work out which workspace an event hook is about.
//
// herdr sets HERDR_WORKSPACE_ID when the invocation has workspace context.
// Fall back to digging through HERDR_PLUGIN_EVENT_JSON, whose shape varies by
// event (`workspace.focused` carries a workspace, `worktree.*` carry the
// opened workspace, pane events carry a pane with its workspace id).

// Accepts `process.env` directly. Keys consulted: HERDR_WORKSPACE_ID,
// HERDR_PLUGIN_EVENT_JSON, HERDR_PLUGIN_CONTEXT_JSON.
export type EventEnv = Record<string, string | undefined>;

function idFrom(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function searchPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const direct = idFrom(obj.workspace_id);
  if (direct) return direct;
  for (const key of ["workspace", "pane", "tab", "params", "event", "context"]) {
    const nested = obj[key];
    if (nested && typeof nested === "object") {
      const found = idFrom((nested as Record<string, unknown>).workspace_id);
      if (found) return found;
    }
  }
  return null;
}

export function resolveEventWorkspaceId(env: EventEnv): string | null {
  const fromEnv = idFrom(env.HERDR_WORKSPACE_ID);
  if (fromEnv) return fromEnv;
  for (const raw of [env.HERDR_PLUGIN_EVENT_JSON, env.HERDR_PLUGIN_CONTEXT_JSON]) {
    if (!raw) continue;
    try {
      const found = searchPayload(JSON.parse(raw));
      if (found) return found;
    } catch {
      // malformed JSON: try the next source
    }
  }
  return null;
}
