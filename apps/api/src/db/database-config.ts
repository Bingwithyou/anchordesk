import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';

export interface DatabaseUrls {
  databaseUrl: string;
  testDatabaseUrl: string;
}

export type DatabaseEnvironment = Partial<
  Record<'DATABASE_URL' | 'TEST_DATABASE_URL', string>
>;

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

export const migrationsDirectory = resolve(repositoryRoot, 'db/migrations');

const loopbackHostnames = new Set(['127.0.0.1', '::1', 'localhost']);

function normalizeHostname(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return loopbackHostnames.has(normalized) ? 'loopback' : normalized;
}

export function loadDatabaseUrls(
  environment: DatabaseEnvironment = process.env,
): DatabaseUrls {
  const environmentFile = resolve(repositoryRoot, '.env');
  const fileEnvironment = existsSync(environmentFile)
    ? parse(readFileSync(environmentFile))
    : {};

  return parseDatabaseUrls({ ...fileEnvironment, ...environment });
}

export function parseDatabaseUrls(environment: DatabaseEnvironment): DatabaseUrls {
  const databaseUrl = environment.DATABASE_URL?.trim();
  const testDatabaseUrl = environment.TEST_DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL');
  }
  if (!testDatabaseUrl) {
    throw new Error('缺少 TEST_DATABASE_URL');
  }

  return { databaseUrl, testDatabaseUrl };
}

function databaseTarget(databaseUrl: string): string {
  const parsedUrl = new URL(databaseUrl);
  const hostname = normalizeHostname(parsedUrl.hostname);
  const port = parsedUrl.port || '5432';
  const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));

  return `${hostname}:${port}/${databaseName}`;
}

export function assertSafeTestDatabaseUrls({
  databaseUrl,
  testDatabaseUrl,
}: DatabaseUrls): void {
  if (
    testDatabaseUrl === databaseUrl ||
    databaseTarget(testDatabaseUrl) === databaseTarget(databaseUrl)
  ) {
    throw new Error('测试数据库不能与开发数据库相同');
  }

  const parsedTestUrl = new URL(testDatabaseUrl);
  const testDatabaseName = decodeURIComponent(parsedTestUrl.pathname.slice(1));
  if (!testDatabaseName.endsWith('_test')) {
    throw new Error('测试数据库名必须以 _test 结尾');
  }

  const testHostname = parsedTestUrl.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!loopbackHostnames.has(testHostname)) {
    throw new Error('测试数据库必须使用回环地址');
  }
}
