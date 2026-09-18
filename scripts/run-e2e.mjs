import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// E2E 只访问回环地址（Fake API :4100、Vite :5173、测试库 :5433），
// 不应走本地代理：Playwright 的 webServer 健康检查会读取 ALL_PROXY 等
// 环境变量，遇到 socks5h:// 之类的协议会直接崩溃（Protocol not supported）。
// 这里只对 Playwright 子进程剥离全部代理变量，不改动本机全局环境；
// 需要真实外网的命令（如 eval:generation 调 DeepSeek）不受影响。
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (/^(all_proxy|http_proxy|https_proxy|ws_proxy|wss_proxy)$/iu.test(name)) {
    delete environment[name];
  }
}
environment.NO_PROXY = '127.0.0.1,localhost';

// 直接以 node 运行 playwright 包的 CLI 入口，避免 Windows 上
// spawn .cmd 文件需要 shell 且存在参数转义问题。
const playwrightCli = fileURLToPath(
  new URL('../node_modules/playwright/cli.js', import.meta.url),
);
const child = spawn(
  process.execPath,
  [playwrightCli, 'test', ...process.argv.slice(2)],
  { env: environment, stdio: 'inherit' },
);

child.on('error', (error) => {
  console.error(`启动 Playwright 失败：${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
