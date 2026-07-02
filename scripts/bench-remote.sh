#!/bin/sh
# Run the benchmark suite on a remote checkout over SSH and print the
# clean result JSON to stdout (progress goes to stderr).
#
# Usage:
#   scripts/bench-remote.sh <ssh-host> [bench args...] > results.json
#
# <ssh-host> is any ssh destination (typically an alias from your
# ~/.ssh/config). The remote machine needs a clone of this repo with
# dependencies installed (pnpm install); point BENCH_REMOTE_DIR at it
# (default: ~/bench/prisma-pglite-bridge). Set BENCH_REMOTE_SYNC=1 to
# hard-reset the remote checkout to origin/main first.
#
# Bench args are forwarded verbatim (keep them free of spaces-in-values;
# they cross an ssh word-splitting boundary) and default to the
# canonical read-path probe: --scenario findmany-focused -n 1000 -w 100 -r 5
#
# Remote assumptions, kept deliberately loose:
# - pnpm on PATH, or a standalone install in ~/Library/pnpm (macOS) /
#   ~/.local/share/pnpm (Linux)
# - caffeinate is used when available (macOS) to keep the machine awake
# - the postgres-pg adapter runs only if the remote checkout has a
#   .env.test with BENCH_POSTGRES_URL; otherwise use --adapter to filter
set -eu

host=${1:?usage: bench-remote.sh <ssh-host> [bench args...]}
shift

if [ $# -eq 0 ]; then
  set -- --scenario findmany-focused -n 1000 -w 100 -r 5
fi

exec ssh "$host" 'sh -s' -- \
  "${BENCH_REMOTE_DIR:-~/bench/prisma-pglite-bridge}" \
  "${BENCH_REMOTE_SYNC:-0}" \
  "$@" <<'REMOTE_SCRIPT'
set -eu

remote_dir=$1
sync=$2
shift 2

case $remote_dir in
"~/"*) remote_dir=$HOME/${remote_dir#"~/"} ;;
esac

PNPM_HOME=${PNPM_HOME:-$HOME/Library/pnpm}
PATH="$PNPM_HOME/bin:$PNPM_HOME:$HOME/.local/share/pnpm:$PATH"
export PATH

cd "$remote_dir"

if [ "$sync" = "1" ]; then
  echo "syncing checkout to origin/main..." >&2
  git fetch origin >&2
  git reset --hard origin/main >&2
fi

echo "running: pnpm bench $* --json" >&2
out=$(mktemp)
trap 'rm -f "$out"' EXIT

if command -v caffeinate >/dev/null 2>&1; then
  NODE_OPTIONS="--expose-gc" caffeinate -i pnpm bench "$@" --json >"$out"
else
  NODE_OPTIONS="--expose-gc" pnpm bench "$@" --json >"$out"
fi

# pnpm and config loaders write banner noise to stdout before the JSON;
# emit only from the first line of the JSON array onward.
awk 'found || /^\[/ { found = 1; print }' "$out"
REMOTE_SCRIPT
