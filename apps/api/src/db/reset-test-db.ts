import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertSafeTestDatabaseUrls,
  loadDatabaseUrls,
  type DatabaseUrls,
} from './database-config.js';
import { runMigrations } from './migrate.js';
import { createDatabasePool } from './pool.js';
import { waitForDatabase } from './wait-for-db.js';

export async function resetTestDatabase(urls: DatabaseUrls): Promise<void> {
  assertSafeTestDatabaseUrls(urls);
  await waitForDatabase({ connectionString: urls.testDatabaseUrl });

  const pool = createDatabasePool(urls.testDatabaseUrl);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('DROP SCHEMA public CASCADE');
        await client.query('CREATE SCHEMA public');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  await runMigrations({ connectionString: urls.testDatabaseUrl });
}

async function main(): Promise<void> {
  await resetTestDatabase(loadDatabaseUrls());
  console.log('测试数据库已重置并完成迁移');
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`重置测试数据库失败：${message}`);
    process.exitCode = 1;
  });
}
