# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## RAG 检索门槛校准

- 校准日期：2026-07-15
- 数据：3 篇中文合成文档、12 个固定问题
- 嵌入模型：Ollama `bge-m3`
- `RAG_TOP_K`：5
- 最终 `RAG_MAX_DISTANCE`：0.45
- 结果：6/6 个答案用例、2/2 个生成级拒答用例、4/4 个检索级拒答用例通过，共 12/12

运行 `npm run eval:retrieval` 会重置测试数据库，使用真实 Ollama 生成向量，并在事务回滚后把不含文档全文和密钥的本地 JSON 报告写入 `reports/retrieval/`。该目录已被 Git 忽略。

## 测试运行

```powershell
npx playwright install chromium
npm run test:e2e
npm run verify
```

`npm run test:e2e` 会重置测试数据库，启动独立端口（4100）上的 Fake API 与 Vite Web，用 Chromium 跑完整浏览器流程；`npm run verify` 串行执行 lint、typecheck、单元测试、集成测试、E2E 与构建。
