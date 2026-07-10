---
"prisma-pglite-bridge": patch
---

`recentP50QueryMs`, `recentP95QueryMs`, and `recentMaxQueryMs` now
cover exactly the documented `QUERY_DURATION_WINDOW_SIZE` most recent
queries. Previously they were computed over the whole retained
buffer, which lazily trims at twice the window — so the effective
window drifted between 1× and 2× depending on trim phase.
