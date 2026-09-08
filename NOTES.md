# "Open MR" from the worktree right-click menu

## Ask

> adds an option when rightclicking on a worktree with a glab status for "open
> MR" so we can just navigate to the MR that way.

## Finding: not achievable purely in this plugin

Herdr's plugin system (v1, current release 0.8.2; checked docs through the
upcoming 0.9.0) has no hook that lets a plugin add an entry to the sidebar's
built-in right-click menu on a workspace/worktree row. This is a platform gap,
not a bug or missing config in this plugin.

### Evidence

1. The plugin docs say so explicitly, in the "Manifest" section of
   `docs/plugins.mdx`:

   > "Runtime action registration and native non-terminal plugin UI are not
   > part of plugin v1. Actions, event hooks, panes, and link handlers are all
   > declared in the manifest."

   (source: `https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/plugins.mdx`)

2. The word "menu" does not appear anywhere else in `plugins.mdx`. The only
   invocation surfaces the manifest/docs describe for `[[actions]]` are:
   - a keybinding (`type = "plugin_action"` in `config.toml`, see
     `docs/plugins.mdx` "Keybindings"),
   - the CLI (`herdr plugin action invoke <id> --plugin <id>`),
   - and, only for the action a `[[link_handlers]]` entry points at, a
     modified click on a matching terminal URL.

   None of these is "right-click a sidebar row."

3. Herdr *does* have a real, built-in right-click menu on Git workspace rows
   (`docs/configuration.mdx`, "Worktrees": *"Worktree actions are available
   from Git workspace rows"* — `New worktree`, `Open worktree...`, `Delete
   worktree checkout...`; `docs/concepts.mdx` separately confirms Herdr
   supports "right-click menus" generally). But that menu's contents are a
   fixed, built-in list. There is no manifest field (no `contexts = [...]`
   value, no separate key) that adds a plugin action to it. The `contexts`
   field on `[[actions]]` (e.g. `["workspace"]`, `["pane", "workspace"]`,
   `["global"]` — surveyed across the other plugins linked on this machine in
   `~/.config/herdr/plugins.json`) only declares what ambient context the
   action needs to run, not where it appears in the UI.

4. Confirmed live: `herdr plugin action invoke open-mr --plugin glab-status`,
   run from a pane in *this* worktree's workspace (`wZ`), executed against
   the **currently UI-focused** workspace instead (`wR`,
   `ngc-org-web-ui/chore-code-rabbit` — a different repo entirely), per
   `herdr plugin log list --plugin glab-status`:

   ```
   context.workspace_id = "wR"  # UI-focused workspace, not the calling pane's HERDR_WORKSPACE_ID ("wZ")
   context.invocation_source = "cli"
   stdout: "[glab-status] chore-code-rabbit: no merge request for chore_code-rabbit ..."
   ```

   So even the two invocation surfaces Herdr does support (keybinding, CLI)
   act on "whatever is focused right now," not on an arbitrary target
   workspace. A context-menu item needs the opposite: act on the row under
   the cursor, which is very often *not* the focused workspace. Herdr's
   action-dispatch model has no notion of "invoke this action against
   workspace X regardless of focus" today (no `--workspace` flag on `herdr
   plugin action invoke`, confirmed via `herdr plugin action invoke --help`).

   (No side effects: that workspace's branch has no MR, so the call was a
   read-only `glab mr view` lookup that logged and exited; nothing was
   opened, changed, or notified.)

## What Herdr would need to add

- A declarative way for a manifest `[[actions]]` entry to opt into the
  built-in sidebar right-click menu for a given context (e.g. a `surface =
  "context_menu"` or `menu = true` field alongside `contexts = ["workspace"]`),
  i.e. exactly the "runtime action registration / native non-terminal plugin
  UI" the docs currently say is out of scope for v1.
- Context targeting that follows the clicked row instead of UI focus: the
  action process would need `HERDR_WORKSPACE_ID` (and
  `HERDR_PLUGIN_CONTEXT_JSON`) set to the *right-clicked* workspace, the way
  `worktree.opened`/`workspace.focused` event hooks already receive the
  affected workspace rather than the focused one.
- Ideally, a way to gate the menu entry on token/metadata state (e.g. "only
  show when this workspace has reported a non-empty `$mr` token") so the
  entry doesn't appear for workspaces without an MR — this plugin already
  clears the `$mr` token for such workspaces (see README "Sidebar setup"), so
  it has the data to support that if Herdr exposed the hook.

## What's already in place on the plugin side (unchanged, verified working)

- `herdr-plugin.toml` already declares the `open-mr` action
  (`contexts = ["workspace"]`, `bun bin/open-mr.ts`), registered correctly
  (`herdr plugin action list --plugin glab-status` lists it).
- `bin/open-mr.ts` correctly resolves the workspace from ambient context
  (`resolveEventWorkspaceId`, which reads `HERDR_WORKSPACE_ID` first and
  falls back to parsing `HERDR_PLUGIN_EVENT_JSON`/`HERDR_PLUGIN_CONTEXT_JSON`),
  looks up the current branch, resolves it to an MR ref
  (`mr-<iid>-review` scratch branches by iid, everything else by branch
  name), opens it with `glab mr view <ref> --web`, and falls back to a herdr
  notification with the URL when no browser can be launched. It already
  no-ops cleanly (log line, no crash) when there is no workspace context, no
  checkout, no branch, or no MR — exactly the inputs a context-menu
  invocation could produce once Herdr supports one.
- The README already documents the two invocation surfaces Herdr *does*
  support today: a keybinding (`prefix+shift+o` example bound to
  `glab-status.open-mr`) and the CLI
  (`herdr plugin action invoke open-mr --plugin glab-status`). Until Herdr
  adds a context-menu hook, binding a key is the closest equivalent to "open
  the MR for the workspace I'm looking at."
- `bun test`: 83 pass / 0 fail (unchanged).

No manifest or source changes were made — there is nothing on the plugin side
to fix; the action is already correct for the invocation surfaces Herdr
provides.
