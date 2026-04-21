import type { PGlite } from '@electric-sql/pglite';
import { type Mock, vi } from 'vitest';
import type { TelemetrySink } from '../utils/adapter-stats.ts';

export interface MockPglite {
  exec: Mock;
  query: Mock;
  waitReady: Promise<void>;
}

export const createMockPglite = (overrides: Partial<MockPglite> = {}): PGlite =>
  ({
    exec: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ fields: [], rows: [] }),
    waitReady: Promise.resolve(),
    ...overrides,
  }) as unknown as PGlite;

export const createMockTelemetry = (): TelemetrySink => ({
  recordQuery: vi.fn(),
  recordLockWait: vi.fn(),
});
