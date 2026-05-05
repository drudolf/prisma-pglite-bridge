---
"prisma-pglite-bridge": patch
---

Internal refactor: regroup `src/` into `pool/`, `telemetry/`, and a
slimmed `utils/`. `PgBridgePool` and its `PgBridgeClient` /
fast-array-parsers helper move to `src/pool/`; `BridgeStats` and the
diagnostics-channel surface move to `src/telemetry/`. `src/utils/` now
holds only cross-cutting helpers. Public API is unchanged.
