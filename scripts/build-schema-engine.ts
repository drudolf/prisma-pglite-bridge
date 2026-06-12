#!/usr/bin/env tsx
/**
 * Build `@prisma/schema-engine-wasm` from prisma-engines source and emit it
 * to `vendor/schema-engine/`, ready to inject into `pushSchema` via the
 * `schemaEngine` option:
 *
 *   const schemaEngine = await import('../vendor/schema-engine/schema_engine.js');
 *   await pushSchema(bridge.adapter, { schema, schemaEngine });
 *
 * The source ref defaults to the exact engine commit of the installed
 * `@prisma/schema-engine-wasm` (its version embeds the hash:
 * `7.8.0-6.<commit>`), so the self-built engine matches the published one.
 * Override with PRISMA_ENGINES_REF=<sha|branch>.
 *
 * Requires: git, jq, Rust with the wasm32-unknown-unknown target, and
 * wasm-bindgen-cli at the version pinned in prisma-engines' Cargo.lock
 * (the script checks and prints the exact install command). Dev profile by
 * default; WASM_BUILD_PROFILE=release additionally needs wasm-opt (binaryen).
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT, 'vendor', 'prisma-engines');
const OUT_DIR = path.join(ROOT, 'vendor', 'schema-engine');
const UPSTREAM = 'https://github.com/prisma/prisma-engines.git';

const run = (cmd: string, cwd: string = ROOT): string =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const resolveRef = (): string => {
  if (process.env.PRISMA_ENGINES_REF) return process.env.PRISMA_ENGINES_REF;
  const require = createRequire(import.meta.url);
  try {
    // The package's exports map doesn't expose package.json — resolve the
    // exported entry and read the sibling manifest instead.
    const entry = require.resolve('@prisma/schema-engine-wasm', { paths: [ROOT] });
    const pkg = path.join(path.dirname(entry), 'package.json');
    const version: string = JSON.parse(readFileSync(pkg, 'utf8')).version;
    const hash = version.split('.').at(-1);
    if (hash && /^[0-9a-f]{40}$/.test(hash)) return hash;
    return fail(`cannot derive engine commit from version "${version}" — set PRISMA_ENGINES_REF`);
  } catch {
    return fail('@prisma/schema-engine-wasm not installed — set PRISMA_ENGINES_REF=<sha|branch>');
  }
};

const checkToolchain = (): void => {
  for (const tool of ['git', 'jq', 'cargo', 'rustup']) {
    if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0) {
      fail(`${tool} not found — install it first`);
    }
  }
  // No wasm32-target check: prisma-engines pins its toolchain (and the
  // wasm32 target) via rust-toolchain.toml, which rustup auto-installs on
  // the first build inside the checkout.
};

const checkWasmBindgen = (): void => {
  const lock = readFileSync(path.join(SRC_DIR, 'Cargo.lock'), 'utf8');
  const want = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
  if (!want) fail('cannot read wasm-bindgen version from Cargo.lock');
  const have = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
  const installed = have.status === 0 ? have.stdout.trim().split(' ').at(-1) : undefined;
  if (installed !== want) {
    fail(
      `wasm-bindgen-cli ${want} required (found: ${installed ?? 'none'}) — run: cargo install wasm-bindgen-cli --version ${want} --locked`,
    );
  }
};

const ref = resolveRef();
checkToolchain();

console.log(`ℹ️  engine source ref: ${ref}`);
if (existsSync(path.join(SRC_DIR, '.git'))) {
  run(`git fetch --depth 1 origin ${ref}`, SRC_DIR);
  run('git checkout --force FETCH_HEAD', SRC_DIR);
} else {
  run(`git init -q ${SRC_DIR}`);
  run(`git remote add origin ${UPSTREAM}`, SRC_DIR);
  run(`git fetch --depth 1 origin ${ref}`, SRC_DIR);
  run('git checkout --force FETCH_HEAD', SRC_DIR);
}
console.log(`ℹ️  source at ${run('git rev-parse HEAD', SRC_DIR)}`);

checkWasmBindgen();

const buildDir = path.join(SRC_DIR, 'schema-engine', 'schema-engine-wasm');
const version = `0.0.0-selfbuilt.${ref.slice(0, 12)}`;

// Upstream build.sh ends with a cosmetic size report that needs GNU numfmt,
// absent on stock macOS — its 127 would fail the otherwise-successful build.
// Shim it (prints the last argument unformatted) rather than patching the
// checkout.
const env = { ...process.env };
if (spawnSync('numfmt', ['--version'], { stdio: 'ignore' }).status !== 0) {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'numfmt-shim-'));
  const shim = path.join(shimDir, 'numfmt');
  writeFileSync(shim, '#!/bin/sh\nfor a; do l=$a; done; printf \'%s\\n\' "$l"\n', { mode: 0o755 });
  env.PATH = `${shimDir}:${env.PATH ?? ''}`;
}

console.log(
  `🔨 building (profile: ${process.env.WASM_BUILD_PROFILE ?? 'dev'}) — this takes a while…`,
);
execSync(`./build.sh ${version} ${OUT_DIR}`, { cwd: buildDir, stdio: 'inherit', env });

console.log(`\n✓ engine built: ${path.relative(ROOT, OUT_DIR)}/schema_engine.js`);
console.log(
  `  inject via: pushSchema(adapter, { schema, schemaEngine: await import('…/vendor/schema-engine/schema_engine.js') })`,
);
