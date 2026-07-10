---
"prisma-pglite-bridge": patch
---

Removed redundant scans in the RowDescription rewrite path: the
in-place rewriter no longer re-runs the needs-rewrite check its
callers already performed (or that its own per-field guard makes
unnecessary), dropping one full frame walk on the zero-copy path and
the check on the chunk-spanning path. Behavior is unchanged.
