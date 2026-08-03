import { describe, expect, it } from 'vitest';

import { loadDatabaseUrls } from '../db/database-config.js';
import {
  createTestApp,
  type TestAppOptions,
} from './test-app.js';

describe('测试 App 数据库安全边界', () => {
  it('拒绝通过配置覆盖开发数据库地址', async () => {
    const { databaseUrl } = loadDatabaseUrls();
    const unsafeConfig = {
      databaseUrl,
    } as unknown as NonNullable<TestAppOptions['config']>;
    let app: ReturnType<typeof createTestApp> | undefined;

    try {
      expect(() => {
        app = createTestApp({ config: unsafeConfig });
      }).toThrowError(/不允许覆盖数据库地址/u);
    } finally {
      await app?.close();
    }
  });
});
