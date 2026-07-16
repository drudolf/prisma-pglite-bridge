---
"prisma-pglite-bridge": patch
---

Remove the contiguous pipeline fast path from `PGliteDuplex`. A counting
probe preloaded into real consumer workloads (Prisma, Drizzle) measured
zero contiguous batches — pg writes each protocol message as its own
chunk from a freshly allocated buffer, so multi-part pipelines are never
adjacent views of one backing buffer and the zero-copy path never
triggered. Pipeline flushes now always use the copying concat path,
removing the buffer-aliasing hazard of views over socket chunks. This
supersedes the 1.1.0 note about avoiding concatenation for contiguous
extended-query batches.
