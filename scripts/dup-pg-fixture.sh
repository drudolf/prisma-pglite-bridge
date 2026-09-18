#!/usr/bin/env bash
# Rebuilds the duplicated-pg scenario behind BRIDGE_OPTIONS_REQUIRED.
# Not run in CI. Usage: scripts/dup-pg-fixture.sh [workdir]
# Expects a built tree (pnpm build) — pnpm pack has no prepack hook.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=${1:-$(mktemp -d)}
tgz=$(cd "$repo" && pnpm pack --pack-destination "$work" 2>/dev/null | tail -1)
mkdir -p "$work/fixture/prisma" && cd "$work/fixture"
cp "$repo/prisma/schema.prisma" prisma/
cp -r "$repo/prisma/migrations" prisma/
cp "$repo/prisma.config.ts" .
printf 'auto-install-peers=false\nlegacy-peer-deps=true\n' > .npmrc
printf '{ "name": "dup-pg-fixture", "private": true, "type": "module" }\n' > package.json
npm install --silent --no-audit --no-fund "$tgz" pg @prisma/adapter-pg@7 @prisma/client@7 prisma@7 @prisma/config@7 @electric-sql/pglite tsx
npx prisma generate >/dev/null
cat > probe.mts <<'TS'
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from './src/generated/prisma/client.js';
const bridge = new PGliteBridge();
try {
  await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
  const prisma = new PrismaClient({ adapter: bridge.adapter });
  console.log('RESULT ok, tenants =', await prisma.tenant.count());
} catch (e: any) {
  console.log('RESULT error', e.code ?? e.name);
}
await bridge.close();
TS
run() { NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx probe.mts 2>&1 | grep RESULT; }
echo '== single pg =='; run
echo '== duplicated pg (nested copy under the bridge) =='
mkdir -p node_modules/prisma-pglite-bridge/node_modules
cp -r node_modules/pg node_modules/prisma-pglite-bridge/node_modules/pg
run
echo "fixture kept at $work/fixture"
