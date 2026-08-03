import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import {
  assertSafeTestDatabaseUrls,
  loadDatabaseUrls,
} from './database-config.js';

export interface WaitForDatabaseOptions {
  connectionString: string;
  retryIntervalMs?: number;
  timeoutMs?: number;
}

export async function waitForDatabase({
  connectionString,
  retryIntervalMs = 250,
  timeoutMs = 30_000,
}: WaitForDatabaseOptions): Promise<void> {
  if (timeoutMs <= 0 || retryIntervalMs <= 0) {
    throw new Error('数据库等待时间必须大于 0');
  }

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: Math.min(1_000, remainingMs),
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await client.end().catch(() => undefined);
    }

    const delayMs = Math.min(retryIntervalMs, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }

  throw new Error(`测试数据库在 ${timeoutMs}ms 内未就绪`, {
    cause: lastError,
  });
}

async function main(): Promise<void> {
  const urls = loadDatabaseUrls();
  assertSafeTestDatabaseUrls(urls);
  await waitForDatabase({ connectionString: urls.testDatabaseUrl });
  console.log('测试数据库已就绪');
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`等待测试数据库失败：${message}`);
    process.exitCode = 1;
  });
}
