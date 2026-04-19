---
'prisma-pglite-bridge': patch
---

Stop the bridge drain loop when the input buffer holds an incomplete
frame. The loop now compares input length before and after each
iteration and breaks when nothing was consumed, instead of spinning
until more data arrives via `_write`.
