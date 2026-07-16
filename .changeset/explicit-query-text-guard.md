---
"prisma-pglite-bridge": patch
---

The duplex's simple-protocol text decoder now guards sub-minimal `Q` frames
(5 bytes, no payload) explicitly instead of relying on `Buffer.from`
clamping a negative length to zero. No observable behavior change; the
crafted-frame passthrough is now pinned by a test.
