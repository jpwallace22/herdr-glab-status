#!/bin/sh
# Stand-in for the herdr binary in tests. Appends each invocation's argv (one
# arg per line, invocations separated by a blank line) to $FAKE_HERDR_LOG and
# exits 0. Set FAKE_HERDR_FAIL=1 to exit 1 instead.
{
  for arg in "$@"; do printf '%s\n' "$arg"; done
  printf '\n'
} >>"${FAKE_HERDR_LOG:?FAKE_HERDR_LOG not set}"
if [ "${FAKE_HERDR_FAIL:-0}" = "1" ]; then
  echo "fake herdr failure" >&2
  exit 1
fi
exit 0
