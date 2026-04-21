# Optional PGlite 0.4.4 memory patch

`@electric-sql/pglite@0.4.4` retains parsed raw-protocol messages
across `execProtocolRaw()` / `execProtocolRawStream()` calls. That
shows up as large memory growth on the bridge path because this
package uses PGlite's raw wire-protocol API.

This repo ships a version-pinned patch for `@electric-sql/pglite@0.4.4`
in [../patches/@electric-sql__pglite@0.4.4.patch](../patches/@electric-sql__pglite@0.4.4.patch).
We apply it in development via `pnpm.patchedDependencies`.

If your project also uses `@electric-sql/pglite@0.4.4`, you can opt
into the same fix. **This workflow is `pnpm`-specific and opt-in —
the bridge functions without it, you only need it if PGlite memory
growth is measurably hurting you.**

## How to apply it in your project

1. Make sure your project is actually using
   `@electric-sql/pglite@0.4.4`.

```sh
pnpm add -D @electric-sql/pglite@0.4.4
pnpm why @electric-sql/pglite
```

If you are also setting up `prisma-pglite-bridge`, install it
separately as usual.

1. Install `prisma-pglite-bridge` so the patch file is available in
   `node_modules`:

```sh
pnpm add -D prisma-pglite-bridge
```

1. Copy the shipped patch file into your own repo:

```sh
mkdir -p patches
cp node_modules/prisma-pglite-bridge/patches/@electric-sql__pglite@0.4.4.patch \
  patches/@electric-sql__pglite@0.4.4.patch
```

1. Add this to your project's `package.json`:

```json
{
  "pnpm": {
    "patchedDependencies": {
      "@electric-sql/pglite@0.4.4": "patches/@electric-sql__pglite@0.4.4.patch"
    }
  }
}
```

1. Reinstall so `pnpm` applies the patch:

```sh
pnpm install
```

1. Verify that the patch is active in `pnpm-lock.yaml`.

You should see:

- a top-level `patchedDependencies` entry for `@electric-sql/pglite@0.4.4`
- patched package keys that include `patch_hash=...`

This patch is intentionally version-specific. Do not apply it to
other PGlite versions unless the patch has been validated for that
exact release.
