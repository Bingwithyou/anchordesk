import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDatabaseUrls } from './database-config.js';
import { runMigrations } from './migrate.js';
import { createDatabasePool } from './pool.js';

const { databaseUrl, testDatabaseUrl } = loadDatabaseUrls();
const pool = createDatabasePool(testDatabaseUrl);

describe('数据库迁移', () => {
  beforeAll(() => {
    expect(testDatabaseUrl).not.toBe(databaseUrl);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('重复运行时不会再次执行已经记录的迁移', async () => {
    await runMigrations({ connectionString: testDatabaseUrl });
    const before = await pool.query<{ applied_at: Date; filename: string }>(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY filename',
    );

    await runMigrations({ connectionString: testDatabaseUrl });
    const after = await pool.query<{ applied_at: Date; filename: string }>(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY filename',
    );

    expect(before.rows).toEqual([
      { applied_at: expect.any(Date), filename: '001_init.sql' },
      {
        applied_at: expect.any(Date),
        filename: '002_document_source_types.sql',
      },
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  it('迁移失败时回滚 SQL 和迁移记录，并释放迁移锁', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anchordesk-migration-'));
    const filename = '999_intentional_failure.sql';
    await writeFile(
      join(directory, filename),
      `
        CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);
        SELECT anchordesk_function_that_does_not_exist();
      `,
    );

    try {
      await expect(
        runMigrations({ connectionString: testDatabaseUrl, directory }),
      ).rejects.toThrow();

      const probe = await pool.query<{ relation: string | null }>(
        "SELECT to_regclass('public.migration_rollback_probe') AS relation",
      );
      const migrationRecord = await pool.query<{ count: string }>(
        'SELECT count(*) FROM schema_migrations WHERE filename = $1',
        [filename],
      );
      expect(probe.rows[0]?.relation).toBeNull();
      expect(migrationRecord.rows[0]?.count).toBe('0');

      const rerun = await runMigrations({ connectionString: testDatabaseUrl });
      expect(rerun).toEqual({
        applied: [],
        skipped: ['001_init.sql', '002_document_source_types.sql'],
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
