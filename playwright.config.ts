import { defineConfig, devices } from '@playwright/test';

// E2E 只与独立端口上的 Fake API 和 Vite Web 交互，绝不复用开发服务器。
const E2E_API_URL = 'http://127.0.0.1:4100';
const E2E_WEB_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  // 所有 E2E 共享同一个测试数据库，必须串行执行。
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  use: {
    baseURL: E2E_WEB_URL,
    // 只在失败时保留 trace，成功时不产生仓库文件。
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run test:e2e:server -w @anchordesk/api',
      url: 'http://127.0.0.1:4100/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @anchordesk/web',
      env: { VITE_API_BASE_URL: E2E_API_URL },
      url: E2E_WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
