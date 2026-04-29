import { PGlite } from '@electric-sql/pglite';
import { bindMigrationAwareSqlAdapterFactory } from '@prisma/driver-adapter-utils';
import { SchemaEngine } from '@prisma/schema-engine-wasm';
import { describe, expect, it } from 'vitest';

import { createPgliteAdapter } from './index.ts';

// End-to-end check that the WASM schema engine can run schemaPush against the
// bridge adapter. Without the RowDescription oid-18 → 25 rewrite in
// BackendMessageFramer, this throws `UnsupportedNativeDataType` from
// @prisma/adapter-pg's fieldToColumnType when introspecting pg_constraint.
const SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

enum Color {
  RED
  BLUE
}

model Widget {
  id    Int    @id @default(autoincrement())
  name  String @unique
  color Color  @default(RED)
}
`;

describe('schema engine via bridge', () => {
  it('schemaPush creates the schema in PGlite', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;

    const { adapter, close } = await createPgliteAdapter({ pglite });

    try {
      const bound = bindMigrationAwareSqlAdapterFactory(adapter);
      const engine = await SchemaEngine.new(
        { datamodels: [['schema.prisma', SCHEMA]] },
        () => {},
        bound,
      );

      try {
        await engine.schemaPush({
          force: false,
          schema: { files: [{ path: 'schema.prisma', content: SCHEMA }] },
          filters: { externalTables: [], externalEnums: [] },
        });

        const tables = await pglite.query<{ table_name: string }>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name
        `);
        expect(tables.rows.map((r) => r.table_name)).toContain('Widget');

        const enums = await pglite.query<{ typname: string }>(`
          SELECT typname FROM pg_type
          WHERE typtype = 'e'
          ORDER BY typname
        `);
        expect(enums.rows.map((r) => r.typname)).toContain('Color');
      } finally {
        engine.free();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });
});
