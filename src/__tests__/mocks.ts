import type { PGlite } from '@electric-sql/pglite';
import { type Mock, vi } from 'vitest';
import type { TelemetrySink } from '../utils/bridge-stats.ts';

interface MockPGlite {
  closed: boolean;
  dataDir?: string;
  exec: Mock;
  execProtocolRawStream: Mock;
  query: Mock;
  ready: boolean;
  runExclusive: Mock;
  waitReady: Promise<void>;
}

export const createMockPGlite = (overrides: Partial<MockPGlite> = {}): PGlite =>
  ({
    closed: false,
    exec: vi.fn().mockResolvedValue(undefined),
    execProtocolRawStream: vi.fn(),
    query: vi.fn().mockResolvedValue({ fields: [], rows: [] }),
    ready: true,
    runExclusive: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    waitReady: Promise.resolve(),
    ...overrides,
  }) as unknown as PGlite;

export const createMockTelemetry = (): TelemetrySink => ({
  recordQuery: vi.fn(),
  recordLockWait: vi.fn(),
});
