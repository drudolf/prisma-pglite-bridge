#!/usr/bin/env bash
# Verifies the npm tarball listing (pnpm pack --dry-run) ships the docs
# and AGENTS.md and omits the contributor-only mutation-testing doc.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
listing=$(cd "$repo" && pnpm pack --dry-run 2>&1)
status=0
for f in docs/troubleshooting.md docs/api.md docs/cookbook.md AGENTS.md; do
  if ! grep -Fxq -- "$f" <<<"$listing"; then
    echo "check-pack: missing from tarball: $f" >&2
    status=1
  fi
done
if grep -Fxq -- docs/mutation-testing.md <<<"$listing"; then
  echo "check-pack: must not ship: docs/mutation-testing.md" >&2
  status=1
fi
if [ "$status" -ne 0 ]; then
  echo "$listing" >&2
  exit "$status"
fi
echo "check-pack: tarball listing OK"
