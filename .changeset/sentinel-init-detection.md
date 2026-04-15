---
"prisma-pglite-bridge": minor
---

Replace catalog-guessing `isInitialized` with sentinel-based detection for persistent `dataDir` reopens. Uses a `_pglite_bridge.__initialized` marker table with transactional writes, pre-commit verification, and a legacy fallback for pre-sentinel databases. Fixes sequence-only and function-only schemas not being detected on reopen.
