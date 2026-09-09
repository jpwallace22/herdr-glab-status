# herdr-glab-status

A [Herdr](https://herdr.dev) plugin that shows each workspace's GitLab merge
request status in the **spaces** sidebar, as a `$mr` token on the workspace row:

```
!575 ✔ ✎2        open MR !575, pipeline passed, 2 unresolved threads
!67 draft ↻      draft MR !67, pipeline running
!12 merged ✔     MR !12 has been merged
!9 closed        MR !9 was closed
(nothing)        the branch has no MR, or the workspace has no checkout
```

Label grammar: `!<iid>[ draft][ merged][ closed][ <pipeline>][ ✎<unresolved>]`.
Pipeline symbols: `✔` success · `✖` failed · `↻` running · `⋯` pending, created,
waiting for resource, preparing · `⊘` canceled or skipped · `⚙` manual. The `✎N`
segment is omitted when there are no unresolved threads.

It is the GitLab counterpart of
[wyattjoh/herdr-plugin-gh-pr](https://github.com/wyattjoh/herdr-plugin-gh-pr),
but reports **workspace-level** tokens (one per worktree/workspace) rather than
pane-level ones, and it keeps itself fresh with a background poller instead of
relying on focus events alone.

## Requirements

- Herdr >= 0.8.2
- [`bun`](https://bun.sh) on your PATH (Herdr runs the hooks with it)
- [`glab`](https://gitlab.com/gitlab-org/cli) authenticated for your GitLab host
  (`glab auth status`). The plugin only ever talks to GitLab through `glab`; it
  never reads or handles tokens itself.
- `git`
- [`fzf`](https://github.com/junegunn/fzf) >= 0.63, only for `pick-mr` (see
  "Picking an MR") — everything else works without it.

## Install

From GitHub:

```bash
herdr plugin install jpwallace22/herdr-glab-status
```

Or link a local checkout while developing:

```bash
git clone https://github.com/jpwallace22/herdr-glab-status ~/code/herdr-glab-status
herdr plugin link ~/code/herdr-glab-status
```

Linking or installing into a running server does not run the startup hook, but
the first focus change or a manual refresh starts the background poller, so you
do not need to restart Herdr. `herdr plugin list` should show `glab-status`
enabled.

## Sidebar setup

Herdr only renders tokens you place in a row. Add `$mr` to the spaces rows in
`~/.config/herdr/config.toml`, then `herdr server reload-config`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status"], ["$mr"]]
```

Workspaces without an MR have their token cleared, so the third row stays empty
for them rather than showing stale text.

## Keybindings

Plugins cannot ship keybindings; bind the actions yourself in
`~/.config/herdr/config.toml` and run `herdr server reload-config`. The
qualified action id is `glab-status.<action>`.

```toml
# refresh every workspace's MR status now
[[keys.command]]
key = "prefix+shift+m"
type = "plugin_action"
command = "glab-status.refresh"
description = "refresh GitLab MR status"

# open the current workspace's MR in the browser
[[keys.command]]
key = "prefix+shift+o"
type = "plugin_action"
command = "glab-status.open-mr"
description = "open GitLab MR"

# pick one of your open MRs with fzf (see "Picking an MR" below)
[[keys.command]]
key = "prefix+shift+p"
type = "plugin_action"
command = "glab-status.pick-mr"
description = "pick a GitLab MR"
```

The same actions work from a shell:

```bash
herdr plugin action invoke refresh --plugin glab-status
herdr plugin action invoke open-mr --plugin glab-status
herdr plugin action invoke pick-mr --plugin glab-status
herdr plugin action invoke stop-poller --plugin glab-status
```

## Picking an MR

`bin/pick-mr.ts` lists one row per workspace with an open MR, in an
[fzf](https://github.com/junegunn/fzf) picker (top-down layout, key legend
pinned to the bottom via `--footer`), sorted with the MRs most likely to
need your attention first (failed pipeline, unresolved threads, missing
approvals — drafts sink to the bottom). It reads a cache (`src/board.ts`,
`<state dir>/mr-board.json`) that the background poller already keeps fresh
every `poll_interval_seconds` — no glab or network call at open time, so
the list appears instantly (single-digit milliseconds). **Requires fzf
0.63+** for `--footer`; `brew upgrade fzf` if you're on an older one.

```bash
bun bin/pick-mr.ts
```

```
REPO          MR    CI        APPR  THR  CMT  AGE  TITLE
catalog-ui    !581  ✖ failed  1/3   1    4    22m  feat: update catalog to use a11y-toolkit
landing-ui    !622  ✔ success 2/3   -    53   3d   chore(e2e): add the service-operations-bot daily triage schedule

[enter]: workspace   [ctrl-o]: browser   [ctrl-r]: refresh   [ctrl-d]: drafts   [alt-m]: mine   [ctrl-s]: scope   [esc]: quit
```

Keys, once the list is up:

| Key | Action |
| --- | --- |
| `enter` | Jump to that MR's workspace (`herdr workspace focus`) |
| `ctrl-o` | Open that MR in the browser instead, reusing `open-mr`'s tab-reuse and notification fallback |
| `ctrl-r` | Refresh the cached data (a live glab pass, same as the `refresh` action) |
| `ctrl-d` | Toggle showing draft MRs |
| `alt-m` | Toggle showing only MRs you authored |
| `ctrl-s` | Toggle scoping to the repo of the workspace you opened the picker from |
| any other text | Fuzzy-filters the list, as usual for fzf |

Everything but `enter` is `ctrl-`-prefixed (or `alt-m` for mine — `ctrl-m`
is the same byte terminals send for Enter, so it can't be bound
separately) so plain letters go to the search box instead of triggering an
action — you can type "docker" without `d` toggling drafts partway through.

`ctrl-d`/`alt-m`/`ctrl-s`/`ctrl-r` all replace the list in place via fzf's
own `reload` binding (`bin/board-rows.ts`) — none of them close the picker.
Filter state is per-session, not persisted: closing the picker and opening
it again always starts from the defaults (all open MRs, no scope), never
remembering a filter you toggled last time. It requires `fzf` on PATH
(`brew install fzf`) and
fails with a clear message if it's missing.

The right-hand preview pane shows the **workspace** the highlighted row
lives in, not a restatement of the row itself: a small identity block
(label, repo, branch, checkout path, live pane/tab counts and focus state
via `herdr workspace get`), then the actual live scrollback of whichever
pane in that workspace has a detected agent (`herdr agent list` +
`herdr agent read`) — the same source and intent as the `sessionizer`
plugin's own agent-view preview. All local socket calls, not glab; the one
part of this whole picker that isn't just reading a cache, since live pane
content and agent/focus state aren't something a poller cycle could
usefully snapshot.

fzf needs a real terminal — it reads the row list from stdin but drives its
own UI straight over `/dev/tty` — and a plugin action's own command doesn't
get one. So the interactive picker runs as a herdr **plugin pane** instead
(`[[panes]] id = "picker"` in `herdr-plugin.toml`, `placement = "overlay"`),
which is a real pane like any other and does get a terminal; the `pick-mr`
**action** (`herdr plugin action invoke pick-mr --plugin glab-status`, or the
keybinding above) just opens/focuses that pane — the same pattern the
`sessionizer` plugin already installed on this machine uses for its own fzf
picker. `bun bin/pick-mr.ts` also still works run directly in any pane.

## How it stays fresh

| Trigger | What happens |
| --- | --- |
| Server start (`[[startup]]`) | Spawns a detached poller that refreshes every workspace immediately and then every `poll_interval_seconds` (default 300). |
| `workspace.focused`, `workspace.created`, `worktree.created`, `worktree.opened` | Refreshes just that workspace, at most once per `throttle_seconds` (default 30) per workspace. Also restarts the poller if it died. |
| `refresh` action | Refreshes every workspace right away, ignoring the throttle. |
| Token TTL | Every token is reported with `--ttl-ms` = `poll_interval_seconds × ttl_multiplier` (default 15 min). If the poller dies, rows fade out instead of lying. |
| Transient `glab` failure (network blip, timeout, an unexpected `glab` error) | The workspace's existing `$mr` token is left exactly as is — no herdr call at all — instead of being blanked. The poller retries in 30s rather than waiting a full `poll_interval_seconds`, so a laptop that wakes with no network catches up quickly; a label that stays wrong keeps aging toward its TTL like any other. |

Per workspace, a refresh is `git branch --show-current`, then
`glab mr view <branch> --output json` run inside the checkout (so `glab` resolves
the project from the git remote), then one paginated pass over the MR's
discussions API. That is two GitLab API calls for a workspace with an MR and one
for a workspace without. Workspaces are processed sequentially.

The poller (and an explicit `refresh` action) also recompute the `pick-mr`
board cache once per cycle — every workspace concurrently this time, plus
one `glab api .../approvals` call per open MR (a field the sidebar token
never needed) — and write it to `<state dir>/mr-board.json`. This is what
lets `pick-mr` itself never touch glab when it opens.

Branches named `mr-<iid>-review` are treated as local scratch checkouts of MR
`<iid>` and resolved by iid instead of by source branch.

The poller exits on its own when the Herdr socket disappears, when Herdr stops
answering, when the `stop-poller` action is invoked, or when a newer poller has
replaced it (after a live server handoff). A stop marker keeps event hooks from
restarting it; the next server start or a manual `refresh` clears the marker.

### Unresolved count

`✎N` counts unresolved **discussion threads** (a discussion with at least one
note that is `resolvable` and not `resolved`), which is the "N unresolved
threads" number GitLab shows on the MR page. The discussions API is paginated at
100 per page and every page is walked, so MRs with hundreds of threads are
counted correctly. If the discussions call fails but the MR itself was found,
the label is shown without the `✎N` segment and a warning is logged.

## Configuration

All keys are optional; the defaults work with no config file at all. The first
server start writes a fully commented template to the plugin config directory:

```bash
herdr plugin config-dir glab-status   # prints the directory
$EDITOR "$(herdr plugin config-dir glab-status)/config.toml"
```

```toml
# Background refresh period for all workspaces (seconds). Default 300, minimum 15.
poll_interval_seconds = 300

# Minimum gap between event-driven refreshes of one workspace (seconds). Default 30.
throttle_seconds = 30

# Token TTL as a multiple of the poll interval. Default 3.
ttl_multiplier = 3

# GitLab host passed to glab as GITLAB_HOST. Default: glab infers it from the remote.
# host = "gitlab.example.com"

# Absolute path to glab if it is not on PATH. Default: PATH, then Homebrew locations.
# glab_path = "/opt/homebrew/bin/glab"

# Count unresolved threads (one extra API call per MR). Default true.
count_unresolved = true

# open-mr: focus an already-open tab for the MR instead of always opening a
# new one. Only takes effect on macOS with Google Chrome, Brave Browser,
# Microsoft Edge, or Arc. Default true.
reuse_tab = true

# open-mr: which app to target for tab reuse. Default: auto-detect the first
# of the apps above that is already running.
# browser = "Google Chrome"

# Verbose logging. Default false.
debug = false
```

Changes are picked up on the poller's next cycle; hooks read the file on every
run.

### Tab reuse for `open-mr`

On macOS, `open-mr` focuses the MR's existing tab instead of opening a new one
if it finds it already open in Google Chrome, Brave Browser, Microsoft Edge,
or Arc — whichever `browser` names, or otherwise the first of those four
already running (checked in that order; nothing is launched just to check).
It drives the browser with AppleScript (`osascript`), so macOS will prompt for
Automation permission for Herdr/`osascript` to control that browser the first
time `open-mr` runs; approve it once and it won't ask again. Set
`reuse_tab = false` to always open a new tab, matching the old behavior. There
is no equivalent on Linux or for other browsers (e.g. Safari, Firefox); those
always open a new tab via `glab mr view --web`. A minimized window is
un-minimized, but a window on a different macOS Space is not brought to the
current one — that's outside what AppleScript alone can do reliably.

## Troubleshooting

- `herdr plugin log list --plugin glab-status` shows the stdout/stderr of every
  hook and action run. It is empty in normal operation; problems appear as
  `[glab-status] warning:` or `[glab-status] error:` lines.
- The poller is detached, so its output is not in that log. It writes to
  `poller.log` in the plugin **state** directory (next to `poller.json`, which
  holds its pid). Set `debug = true` to log every cycle and label.
- `glab` missing or unauthenticated: logged once, every `$mr` token is cleared,
  and the poller keeps retrying each cycle until `glab` works again.
- A single workspace with a definite "no MR" answer (no MR for the branch, a
  deleted project) clears only that workspace's token; the rest are
  unaffected. A checkout whose remote isn't GitLab at all (e.g. it points to
  GitHub) is treated the same way — glab's own message suggests `glab auth
  login`, but that workspace is simply cleared, not treated as an auth
  failure.
- A transient failure (network blip, `glab` timing out, an unexpected `glab`
  error) does **not** clear the token — the last known label is left in place
  and a warning is logged, and the poller retries in 30s instead of the full
  interval. A row only goes blank if it stays wrong long enough to hit its
  TTL.
- Nothing shows up: check that `$mr` is in `[ui.sidebar.spaces].rows`, that
  `glab mr view <branch> --output json` works inside the checkout, and that
  `herdr workspace list` reports a `worktree.checkout_path` for the workspace.
  Workspaces without a checkout are skipped.

## Development

```bash
bun test                                   # unit tests (no network, no herdr needed)
herdr plugin link "$PWD"                   # register this checkout
herdr plugin action invoke refresh --plugin glab-status
herdr plugin log list --plugin glab-status
herdr plugin unlink glab-status
```

Layout: `herdr-plugin.toml` (manifest), `bin/` (hook, action, and plugin-pane
entrypoints: `startup`, `update`, `poller`, `open-mr`, `open-pick-mr`,
`pick-mr`, `board-rows`, `stop`), `src/` (label formatting, branch → MR
resolution, discussion paging, glab/herdr wrappers, refresh loop, poller
control, macOS tab-reuse for `open-mr`, `board.ts`'s pick-mr board
computation/caching, `board-filters.ts`'s s/d/m toggle state, `picker.ts`'s
filtering/sorting/formatting over the cached board), `tests/`.

Why Bun/TypeScript: it matches the gh-pr reference plugin, needs no build step or
dependencies (Bun runs `.ts` directly and ships a TOML parser), and gives the
label/pagination/decision logic a real test suite, which the original bash
prototype lacked.

### Publishing to the marketplace

The Herdr [marketplace](https://herdr.dev/plugins/) indexes public GitHub
repositories tagged with the **`herdr-plugin`** topic that contain a
`herdr-plugin.toml`. This repo lives at
[github.com/jpwallace22/herdr-glab-status](https://github.com/jpwallace22/herdr-glab-status);
to list it, add that topic (`gh repo edit jpwallace22/herdr-glab-status --add-topic herdr-plugin`).
The index refreshes every 30 minutes.

## License

[MIT](LICENSE)
