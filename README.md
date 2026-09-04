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
```

The same actions work from a shell:

```bash
herdr plugin action invoke refresh --plugin glab-status
herdr plugin action invoke open-mr --plugin glab-status
herdr plugin action invoke stop-poller --plugin glab-status
```

## How it stays fresh

| Trigger | What happens |
| --- | --- |
| Server start (`[[startup]]`) | Spawns a detached poller that refreshes every workspace immediately and then every `poll_interval_seconds` (default 300). |
| `workspace.focused`, `workspace.created`, `worktree.created`, `worktree.opened` | Refreshes just that workspace, at most once per `throttle_seconds` (default 30) per workspace. Also restarts the poller if it died. |
| `refresh` action | Refreshes every workspace right away, ignoring the throttle. |
| Token TTL | Every token is reported with `--ttl-ms` = `poll_interval_seconds × ttl_multiplier` (default 15 min). If the poller dies, rows fade out instead of lying. |

Per workspace, a refresh is `git branch --show-current`, then
`glab mr view <branch> --output json` run inside the checkout (so `glab` resolves
the project from the git remote), then one paginated pass over the MR's
discussions API. That is two GitLab API calls for a workspace with an MR and one
for a workspace without. Workspaces are processed sequentially.

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

# Verbose logging. Default false.
debug = false
```

Changes are picked up on the poller's next cycle; hooks read the file on every
run.

## Troubleshooting

- `herdr plugin log list --plugin glab-status` shows the stdout/stderr of every
  hook and action run. It is empty in normal operation; problems appear as
  `[glab-status] warning:` or `[glab-status] error:` lines.
- The poller is detached, so its output is not in that log. It writes to
  `poller.log` in the plugin **state** directory (next to `poller.json`, which
  holds its pid). Set `debug = true` to log every cycle and label.
- `glab` missing or unauthenticated: logged once, every `$mr` token is cleared,
  and the poller keeps retrying each cycle until `glab` works again.
- A single workspace failing (bad remote, deleted project, network blip) clears
  only that workspace's token; the rest are unaffected.
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

Layout: `herdr-plugin.toml` (manifest), `bin/` (hook and action entrypoints:
`startup`, `update`, `poller`, `open-mr`, `stop`), `src/` (label formatting,
branch → MR resolution, discussion paging, glab/herdr wrappers, refresh loop,
poller control), `tests/`.

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
