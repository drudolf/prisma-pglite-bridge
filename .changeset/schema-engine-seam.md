---
"prisma-pglite-bridge": minor
---

`pushSchema` accepts a `schemaEngine` option to inject an alternative
schema-engine WASM module (new exported type `SchemaEngineModule`) instead of
dynamically importing `@prisma/schema-engine-wasm`. This decouples the bridge
from the published package — e.g. for engine builds compiled directly from
`prisma-engines` source. When omitted, behavior is unchanged.
