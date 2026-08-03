import { describe, expect, it } from 'vitest';

import {
  assertSafeTestDatabaseUrls,
  parseDatabaseUrls,
} from './database-config.js';

describe('测试数据库安全边界', () => {
  it('拒绝与开发数据库完全相同的测试 URL', () => {
    const databaseUrl =
      'postgres://postgres:postgres@127.0.0.1:5434/anchordesk';

    expect(() =>
      assertSafeTestDatabaseUrls({ databaseUrl, testDatabaseUrl: databaseUrl }),
    ).toThrow('测试数据库不能与开发数据库相同');
  });

  it('拒绝数据库名不以 _test 结尾的测试 URL', () => {
    expect(() =>
      assertSafeTestDatabaseUrls({
        databaseUrl:
          'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
        testDatabaseUrl:
          'postgres://postgres:postgres@127.0.0.1:5433/anchordesk_shadow',
      }),
    ).toThrow('测试数据库名必须以 _test 结尾');
  });

  it('拒绝不在回环地址上的测试数据库', () => {
    expect(() =>
      assertSafeTestDatabaseUrls({
        databaseUrl:
          'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
        testDatabaseUrl:
          'postgres://postgres:postgres@192.168.1.20:5433/anchordesk_test',
      }),
    ).toThrow('测试数据库必须使用回环地址');
  });

  it('拒绝凭据不同但指向同一目标的测试 URL', () => {
    expect(() =>
      assertSafeTestDatabaseUrls({
        databaseUrl: 'postgres://postgres:dev@localhost:5432/anchordesk_test',
        testDatabaseUrl:
          'postgres://postgres:test@LOCALHOST/anchordesk_test',
      }),
    ).toThrow('测试数据库不能与开发数据库相同');
  });

  it('将 localhost 和 127.0.0.1 视为同一回环目标', () => {
    expect(() =>
      assertSafeTestDatabaseUrls({
        databaseUrl:
          'postgres://postgres:dev@127.0.0.1:5433/anchordesk_test',
        testDatabaseUrl:
          'postgres://postgres:test@localhost:5433/anchordesk_test',
      }),
    ).toThrow('测试数据库不能与开发数据库相同');
  });
});

describe('数据库环境变量', () => {
  it('缺少 TEST_DATABASE_URL 时直接失败', () => {
    expect(() =>
      parseDatabaseUrls({
        DATABASE_URL:
          'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
      }),
    ).toThrow('缺少 TEST_DATABASE_URL');
  });
});
