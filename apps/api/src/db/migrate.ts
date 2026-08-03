import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PoolClient } from 'pg';

import {
  assertSafeTestDatabaseUrls,
  loadDatabaseUrls,
  migrationsDirectory,
} from './database-config.js';
import { createDatabasePool } from './pool.js';

export interface RunMigrationsOptions {
  connectionString: string;
  directory?: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

interface MigrationFile {
  checksum: string;
  filename: string;
  sql: string;
}

async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter(
      (entry) =>
        entry.isFile() && /^\d+_[a-z0-9_-]+\.sql$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0) {
    throw new Error('没有找到数据库迁移文件');
  }

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { checksum, filename, sql };
    }),
  );
}

export async function runMigrations({
  connectionString,
  directory = migrationsDirectory,
}: RunMigrationsOptions): Promise<MigrationResult> {
  const migrations = await loadMigrationFiles(directory);
  const pool = createDatabasePool(connectionString);
  let client: PoolClient | undefined;
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    client = await pool.connect();
    await client.query(
      "SELECT pg_advisory_lock(hashtext('anchordesk_schema_migrations'))",
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [migration.filename],
      );

      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== migration.checksum) {
          throw new Error(`已执行的迁移内容发生变化：${migration.filename}`);
        }
        result.skipped.push(migration.filename);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [migration.filename, migration.checksum],
        );
        await client.query('COMMIT');
        result.applied.push(migration.filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return result;
  } finally {
    // 销毁迁移专用连接；PostgreSQL 会随会话关闭释放 advisory lock。
    // 这样连接、迁移或显式解锁出错时都不会跳过资源清理或掩盖原异常。
    client?.release(true);
    await pool.end();
  }
}

async function main(): Promise<void> {
  const urls = loadDatabaseUrls();
  const useTestDatabase = process.argv.includes('--test');

  if (useTestDatabase) {
    assertSafeTestDatabaseUrls(urls);
  }

  const result = await runMigrations({
    connectionString: useTestDatabase ? urls.testDatabaseUrl : urls.databaseUrl,
  });
  console.log(
    `数据库迁移完成：新执行 ${result.applied.length}，已跳过 ${result.skipped.length}`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`数据库迁移失败：${message}`);
    process.exitCode = 1;
  });
}
