#!/bin/sh
# One-shot per-machine benchmark matrix for the post-refactor regression check.
# Usage: bench-matrix.sh <repo-dir> <out-dir> <label>
# Native-PG baseline lifecycle + regression scenarios + ORM harness.
# Core bench captured as --json per scenario; ORM as text (no --json).
set -u
REPO="$1"; OUT="$2"; LABEL="$3"
PNPM_HOME_MAC="$HOME/Library/pnpm"; PNPM_HOME_LINUX="$HOME/.local/share/pnpm"
PATH="$PNPM_HOME_MAC/bin:$PNPM_HOME_MAC:$PNPM_HOME_LINUX/bin:$PNPM_HOME_LINUX:$HOME/.local/bin:$PATH"
export PATH
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$REPO" || exit 1
log(){ echo "[$LABEL $(date +%H:%M:%S)] $*" >&2; }
CAF=""; command -v caffeinate >/dev/null 2>&1 && CAF="caffeinate -i"

# Entrypoints default to the pnpm scripts (local); remotes override these with
# tsx-direct forms (BENCH_CMD/PGSERVER_CMD/ORM_CMD) to sidestep pnpm's policy
# gate and the missing standalone-pnpm on hetzner.
BENCH="${BENCH_CMD:-pnpm bench}"
PGSERVER="${PGSERVER_CMD:-pnpm bench:pg-server}"
ORM="${ORM_CMD:-pnpm bench:orm}"

# runbench <outfile> <bench args...>  (do NOT pass a comma list to --adapter;
# omit --adapter for all-three, or pass exactly one name)
runbench(){ out="$1"; shift; log "bench $*"
  NODE_OPTIONS="--expose-gc" $CAF $BENCH "$@" --json 2>>"$OUT/stderr.log" \
    | awk 'found||/^\[/{found=1;print}' > "$OUT/$out"
  sz=$(wc -c <"$OUT/$out" 2>/dev/null || echo 0)
  if [ "$sz" -gt 200 ]; then log "  -> $out ok (${sz}b)"; else log "  -> $out EMPTY/BAD (${sz}b)"; fi
}

# run_scenario <basename> <scenario args without --adapter>
run_scenario(){ base="$1"; shift
  if [ "$NATIVE" -eq 1 ]; then
    runbench "${base}_all.json" "$@"                       # omit --adapter -> all 3
  else
    runbench "${base}_bridge.json" --adapter bridge "$@"
    runbench "${base}_direct.json" --adapter pglite-prisma-adapter "$@"
  fi
}

# --- clear any leftover postmaster holding port 5433 ---
if command -v fuser >/dev/null 2>&1; then fuser -k -TERM 5433/tcp >/dev/null 2>&1 || true; fi
lp=$(lsof -ti tcp:5433 2>/dev/null || true); [ -n "$lp" ] && { log "killing leftover pg on 5433: $lp"; kill -TERM $lp 2>/dev/null || true; }
sleep 2

# --- start pg-server ---
log "starting pg-server"
$CAF $PGSERVER > "$OUT/pgserver.log" 2>&1 &
PGPID=$!
ready=0
for i in $(seq 1 150); do
  grep -q '^ready' "$OUT/pgserver.log" 2>/dev/null && { ready=1; break; }
  kill -0 "$PGPID" 2>/dev/null || { log "pg-server launcher died"; break; }
  sleep 1
done
if [ "$ready" -eq 1 ]; then log "pg-server ready"; NATIVE=1
else log "PG-SERVER FAILED"; tail -10 "$OUT/pgserver.log" >&2; NATIVE=0; fi

run_scenario findmany --scenario findmany-focused -n 1000 -w 100 -r 5
if [ "$NATIVE" -eq 1 ]; then
  export BENCH_POSTGRES_PREPARED=1
  runbench findmany_prepared.json --adapter postgres-pg --scenario findmany-focused -n 1000 -w 100 -r 5
  unset BENCH_POSTGRES_PREPARED
fi
run_scenario readmix --scenario read-mix -n 400 -w 40
run_scenario tx_indexed --scenario tx-focused -n 2000 -w 200
export BENCH_TX_UNINDEXED=1
run_scenario tx_unindexed --scenario tx-focused -n 2000 -w 200
unset BENCH_TX_UNINDEXED
run_scenario micro --scenario micro -n 60 -w 10 -r 3

log "orm harness (text tables — no --json)"
NODE_OPTIONS="--expose-gc" $CAF $ORM -r 3 > "$OUT/orm.txt" 2>>"$OUT/stderr.log"
log "  -> orm.txt ($(wc -l <"$OUT/orm.txt" 2>/dev/null || echo 0) lines)"

if kill -0 "${PGPID:-0}" 2>/dev/null; then
  log "stopping pg-server"; kill -TERM "$PGPID" 2>/dev/null
  for i in $(seq 1 15); do kill -0 "$PGPID" 2>/dev/null || break; sleep 1; done
fi
log "DONE native=$NATIVE"
ls -la "$OUT"/*.json "$OUT"/*.txt 2>/dev/null >&2
echo "MATRIX_COMPLETE native=$NATIVE label=$LABEL"
