import { describe, expect, it, vi } from 'vitest';

import { createBridgeTest, setupPGliteBridge } from './vitest.ts';

// Validation-only unit tests. setupPGliteBridge must reject invalid option
// combinations before any PGliteBridge (and thus any PGlite) is created, so
// a stub client factory is all these need and no real DB work ever happens.
describe('setupPGliteBridge option validation', () => {
  it('rejects with a TypeError mentioning "exactly one" when both migrations and schema are given', async () => {
    const rejection = setupPGliteBridge({
      client: () => ({}),
      migrations: true,
      schema: { schema: 'model Empty { id Int @id }' },
    });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow('exactly one');
  });

  it('rejects with a TypeError mentioning "exactly one" when neither migrations nor schema is given', async () => {
    const rejection = setupPGliteBridge({ client: () => ({}) });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow('exactly one');
  });

  it('does not invoke the client factory when validation fails', async () => {
    const client = vi.fn(() => ({}));
    await expect(setupPGliteBridge({ client })).rejects.toThrow(TypeError);
    expect(client).not.toHaveBeenCalled();
  });

  it('validates before constructing the bridge', async () => {
    // An invalid statsLevel makes the PGliteBridge constructor throw its own
    // Error. The exactly-one TypeError must win, proving validation runs
    // before `new PGliteBridge(options.bridge)`.
    await expect(
      setupPGliteBridge({
        client: () => ({}),
        bridge: { statsLevel: 'bogus' as never },
      }),
    ).rejects.toThrow('exactly one');
  });
});

// createBridgeTest builds a vitest test API up front, so invalid option
// combinations must fail synchronously at call time — not when the first
// test using the fixtures runs.
describe('createBridgeTest option validation', () => {
  it('throws a TypeError mentioning "exactly one" when both migrations and schema are given', () => {
    const invalid = () =>
      createBridgeTest({
        client: () => ({}),
        migrations: true,
        schema: { schema: 'model Empty { id Int @id }' },
      });
    expect(invalid).toThrow(TypeError);
    expect(invalid).toThrow('exactly one');
  });

  it('throws a TypeError mentioning "exactly one" when neither migrations nor schema is given', () => {
    const invalid = () => createBridgeTest({ client: () => ({}) });
    expect(invalid).toThrow(TypeError);
    expect(invalid).toThrow('exactly one');
  });

  it('does not invoke the client factory when validation fails', () => {
    const client = vi.fn(() => ({}));
    expect(() => createBridgeTest({ client })).toThrow('exactly one');
    expect(client).not.toHaveBeenCalled();
  });

  it('returns a test API without running any setup', () => {
    const client = vi.fn(() => ({}));
    const bridgeTest = createBridgeTest({ client, migrations: true });
    expect(bridgeTest).toBeTypeOf('function');
    // Setup (bridge, schema, client, seed, snapshot) is per-scope work that
    // happens lazily at test time — creating the test API must not run it.
    expect(client).not.toHaveBeenCalled();
  });
});
