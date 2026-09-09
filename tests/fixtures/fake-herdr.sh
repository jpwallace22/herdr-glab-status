#!/bin/sh
# Stand-in for the herdr binary in tests. Appends each invocation's argv (one
# arg per line, invocations separated by a blank line) to $FAKE_HERDR_LOG and
# exits 0. Set FAKE_HERDR_FAIL=1 to exit 1 instead.
#
# For a `workspace list` call specifically, also prints $FAKE_HERDR_WORKSPACES_JSON
# to stdout if set -- opt-in, so existing tests that don't set it see the same
# empty-stdout behavior as before.
{
  for arg in "$@"; do printf '%s\n' "$arg"; done
  printf '\n'
} >>"${FAKE_HERDR_LOG:?FAKE_HERDR_LOG not set}"
if [ "${FAKE_HERDR_FAIL:-0}" = "1" ]; then
  echo "fake herdr failure" >&2
  exit 1
fi
if [ "$1" = "workspace" ] && [ "$2" = "list" ] && [ -n "${FAKE_HERDR_WORKSPACES_JSON:-}" ]; then
  printf '%s' "$FAKE_HERDR_WORKSPACES_JSON"
fi
exit 0
