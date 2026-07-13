---
"prisma-pglite-bridge": patch
---

Roll back an abandoned transaction even when the client is released with a finite query still in flight. The release-time cleanup now registers a link on the client's submission chain and judges state when the in-flight work settles: an abandoned transaction is rolled back before any next-checkout query (previously the SessionLock stayed owned and sibling clients blocked until teardown), an unawaited COMMIT no longer draws a spurious warning, an unawaited BEGIN is now recovered once it settles, and a teardown that wins the race hands off to the duplex backstop. Releases with a bare in-flight Submittable (an abandoned cursor) keep the previous skip behavior.
