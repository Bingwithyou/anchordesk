import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadDatabaseUrls } from './database-config.js';
import { createDatabasePool } from './pool.js';
import { resetTestDatabase } from './reset-test-db.js';
import { waitForDatabase } from './wait-for-db.js';

const urls = loadDatabaseUrls();
const { testDatabaseUrl } = urls;

describe('测试数据库工具', () => {
  it('等待测试数据库可以执行 SELECT 1', async () => {
    await expect(
      waitForDatabase({ connectionString: testDatabaseUrl, timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();
  });

  it('数据库不可连接时在期限内失败', async () => {
    await expect(
      waitForDatabase({
        connectionString:
          'postgres://postgres:postgres@127.0.0.1:1/anchordesk_test',
        retryIntervalMs: 20,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('测试数据库在 100ms 内未就绪');
  });

  it('重建 public schema 并重新执行迁移', async () => {
    const setupPool = createDatabasePool(testDatabaseUrl);
    try {
      await setupPool.query('DROP TABLE IF EXISTS reset_probe');
      await setupPool.query('CREATE TABLE reset_probe (id integer PRIMARY KEY)');
      await setupPool.query(
        `
          INSERT INTO documents (
            id, title, content, source_type, created_at, updated_at, indexed_at
          ) VALUES ($1, '重置前', '待清理', 'text', NOW(), NOW(), NOW())
        `,
        [randomUUID()],
      );
    } finally {
      await setupPool.end();
    }

    await resetTestDatabase(urls);

    const verificationPool = createDatabasePool(testDatabaseUrl);
    try {
      const state = await verificationPool.query<{
        documents: string;
        migration_count: string;
        reset_probe: string | null;
        vector_version: string;
      }>(`
        SELECT
          (SELECT count(*) FROM documents) AS documents,
          (SELECT count(*) FROM schema_migrations) AS migration_count,
          to_regclass('public.reset_probe')::text AS reset_probe,
          (SELECT extversion FROM pg_extension WHERE extname = 'vector')
            AS vector_version
      `);
      const index = await verificationPool.query<{ count: string }>(`
        SELECT count(*)
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'document_chunks_embedding_hnsw_idx'
      `);

      expect(state.rows[0]).toMatchObject({
        documents: '0',
        migration_count: '2',
        reset_probe: null,
        vector_version: expect.stringMatching(/^\d+\.\d+/u),
      });
      expect(index.rows[0]?.count).toBe('1');
    } finally {
      await verificationPool.end();
    }
  });

  it('开发库和测试库属于两个独立 PostgreSQL 集群', async () => {
    const developmentPool = createDatabasePool(urls.databaseUrl);
    const testPool = createDatabasePool(urls.testDatabaseUrl);

    try {
      const [development, test] = await Promise.all([
        developmentPool.query<{
          database_name: string;
          system_identifier: string;
        }>(`
          SELECT
            current_database() AS database_name,
            (pg_control_system()).system_identifier::text AS system_identifier
        `),
        testPool.query<{
          database_name: string;
          system_identifier: string;
        }>(`
          SELECT
            current_database() AS database_name,
            (pg_control_system()).system_identifier::text AS system_identifier
        `),
      ]);

      expect(development.rows[0]?.database_name).toBe('anchordesk');
      expect(test.rows[0]?.database_name).toBe('anchordesk_test');
      expect(development.rows[0]?.system_identifier).not.toBe(
        test.rows[0]?.system_identifier,
      );
    } finally {
      await Promise.all([developmentPool.end(), testPool.end()]);
    }
  });
});
