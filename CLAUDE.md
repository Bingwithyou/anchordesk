# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AnchorDesk 是一个仅供开发者本人本机运行（回环地址）的中文 RAG 知识库问答系统：文档入库 → 分块向量化 → pgvector 检索 → DeepSeek 结构化生成 → 引用校验 → 回答或确定性拒答，并附带反馈与「待处理」审核闭环。检索不到依据时绝不编造答案。只允许录入合成数据或公开数据。

技术栈：npm workspaces monorepo（`apps/web` React 19 + Vite 8 + Tailwind CSS 4；`apps/api` Fastify 5 + TypeScript；`packages/shared` 共享类型）、PostgreSQL 16 + pgvector（docker-compose 提供）、Ollama `bge-m3` 本机向量嵌入（1024 维）、DeepSeek 生成。测试用 Vitest、Playwright、oxlint。

两份权威文档（改动涉及产品行为前应先读）：
- `README.md`：功能、从空环境启动步骤、端口表、FAQ、非目标。
- `docs/2026-06-30-anchordesk-mvp.md`：MVP 开发说明书，含全部产品合同（问答、文档、生成结果、拒答、外部错误、不可变日志、反馈与审核）、数据库不变量与事务边界，是行为争议的裁决依据。

## 常用命令

全部在仓库根目录用 npm 执行（Node 版本限制：`>=20.19.0 <21`）。

```bash
npm install                 # 安装（首次）
docker compose up -d        # 启动两个 pgvector 容器：开发库 127.0.0.1:5434、测试库 127.0.0.1:5433（tmpfs）
npm run migrate             # 对开发库执行迁移；npm run migrate:test 对测试库
npm run dev                 # 仅启动 web（先构建 shared）；npm run dev:api 启动 API（同样先构建 shared）
```

从空环境启动的完整顺序（README 第八节）：`npm ci` → `docker compose up -d postgres postgres-test` → `docker compose ps` 确认 healthy → `ollama pull bge-m3` → `npm run migrate` → `npx playwright install chromium`（仅 E2E 需要）。

测试（依赖测试库容器已启动；测试库会被整体清空重建）：

```bash
npm run test                 # 单元测试（仅 api workspace，排除 *.integration.test.ts，不需要数据库）
npm run test:integration     # 集成测试（先自动 db:test:reset，串行运行）
npm run test:e2e             # Playwright E2E（先自动 db:test:reset；自起 Fake API :4100 + Vite :5173）
npm run test -w @anchordesk/api -- src/rag/chunk.test.ts                    # 单个单元测试
npm run db:test:reset && npm run test:integration -w @anchordesk/api -- src/routes/questions.integration.test.ts  # 单个集成测试
```

质量与评测：

```bash
npm run lint / npm run typecheck / npm run build   # oxlint / tsc（含 shared 构建与 e2e tsconfig）/ 全部构建
npm run verify                 # 完整门禁：lint + typecheck + test + test:integration + test:e2e + build（不调用真实 DeepSeek）
npm run eval:retrieval         # 真实 Ollama 向量 + fixtures 检索评测（免费），报告写入 reports/retrieval/（已 gitignore）
npm run eval:generation        # 真实 Ollama + DeepSeek 生成评测（付费，可能产生 API 费用）
```

配置来自根目录 `.env`（已 gitignore，模板见 `.env.example`）。所有变量必填（`DEEPSEEK_API_KEY` 也不能为空），由 `apps/api/src/config.ts` 用 zod 严格校验，启动时缺失即报错。跑真实问答需要本机 Ollama 已拉取 `bge-m3`。

## 本地端口与安全边界

| 服务 | 地址 |
|---|---|
| Web | `127.0.0.1:5173` |
| API | `127.0.0.1:4000` |
| 开发 PostgreSQL | `127.0.0.1:5434` |
| 测试 PostgreSQL | `127.0.0.1:5433` |
| Ollama | `127.0.0.1:11434` |

所有服务只监听回环地址，不支持局域网或公网访问；不部署任何公网服务。`DEEPSEEK_API_KEY` 只存在于本机 `.env`，不要提交 `.env`。`docs/` 是 GitHub Pages 静态项目介绍页，不运行真实 RAG。

## 产品合同（改代码时必须保持的行为）

- **外部错误 ≠ 知识拒答**：Ollama/DeepSeek 连接失败返回 502、超时返回 504，是明确的系统错误，不进入 Review Queue；知识拒答是固定文案 `知识库中没有足够依据回答这个问题。` 并带结构化 `RefusalReason`。两者不可混淆。
- **拒答两级**：检索级（`no_chunks`、`low_similarity`）与生成级（`model_refused`、`empty_answer`、`invalid_model_output`、`invalid_citation`）。
- **文档输入限制**：标题 1–120 字符；正文非空且 UTF-8 不超过 100 KB；`sourceType` 只能 `markdown`/`text`（.md/.txt 映射）。创建/更新必须同时完成文档写入与全部向量索引，任何一步失败不留半成品；更新带 `expectedUpdatedAt` 乐观并发校验，冲突返回 409。
- **问题输入**：去空白后 1–2000 字符；单轮无会话历史。
- **不可变审计日志**：`question_logs` 与 `question_log_hits` 创建后禁止 UPDATE/DELETE（迁移里有触发器强制，ERRCODE 55000）；`source_document_id`/`source_chunk_id` 不建外键，是刻意保留的历史快照。测试清理靠重建 schema，不删审计行。
- **事务边界**：文档写入、日志+快照写入、feedback+队列项写入必须在事务中；事务内禁止任何 Ollama/DeepSeek 网络调用（先完成网络调用，事务只负责最终写入）。
- 其他状态码合同：请求不合法 400、资源不存在 404、重复提交反馈或重复解决队列项 409；审核备注 1–1000 字。

## 架构

**分层（API）**：`src/server.ts`（入口，装配真实 Provider）→ `src/app.ts` 的 `buildApp(config, providers, database?)`（Fastify 工厂：注册路由并注入 service，集中错误处理器把 `*ServiceError` / `ProviderError` 映射为 `{code, message}` 中文响应）→ `routes/*`（极薄，`FastifyPluginAsync`，仅转发到 service）→ `services/*`（领域逻辑 + 内联 SQL；`createXService` 工厂接收 `database` + providers + RAG 配置）。`packages/shared/src/types.ts` 是 API 契约的唯一来源，web 与 api 共用；消费方编译前必须先构建 shared（npm scripts 已处理）。

**问答流水线**（`services/question-service.ts` 编排）：embed → `rag/retrieve.ts`（pgvector `<=>` 余弦距离取 topK；按 `RAG_MAX_DISTANCE=0.45` 门槛把候选拆成 `candidates` / `evidence`）→ `AnswerProvider.generate` → `rag/answer-contract.ts` 严格校验模型输出：必须是纯 JSON `{answer, supported, citationRanks}`，answer 内的 `[n]` 行内引用必须与声明的 ranks 完全一致且都能解析到实际证据，任何违例即拒答。提示词在 `rag/prompt.ts`，仅 `PROMPT_VERSION=v1` 一个版本。DeepSeek 请求固定 `thinking: disabled`、`temperature: 0.2`、`response_format: json_object`。

**审计与审核闭环**：每次提问在单事务内写入不可变快照 `question_logs` + `question_log_hits`（含全部候选、距离、是否过门槛、是否被引用），删除/编辑文档不影响历史日志。拒答自动在 `review_queue` 生成 open 条目；`not_helpful` 反馈同样入队（与 feedback 写入同事务），由「待处理」页备注并解决。helpful 只写 feedback 不入队。

**Provider 抽象**：`src/providers/types.ts` 定义 `EmbeddingProvider`（Ollama bge-m3，回环地址）与 `AnswerProvider`（DeepSeek，JSON 契约）接口；真实实现与测试 Fake 都实现该接口，通过 `buildApp` 注入，业务代码不直接依赖具体厂商。`AnswerProvider` 只返回原始文本，JSON 解析与引用校验全部由 `answer-contract.ts` 负责。

**数据库**：迁移文件在 `db/migrations/NNN_name.sql`，带 sha256 校验和与 advisory lock，已应用的迁移禁止修改（否则报错）。`reset-test-db.ts` 是 drop schema public + 重新迁移。测试库安全约束由 `db/database-config.ts` 的 `assertSafeTestDatabaseUrls` 强制：测试库名必须以 `_test` 结尾、使用回环地址、不得与开发库相同。

**Web**：无路由库，`App.tsx` 以 tab state 切换四个页面（问答/知识文档/运行日志/待处理）；`api/client.ts` 是带类型契约的 fetch 封装，抛 `ApiClientError`。`VITE_API_BASE_URL` 可覆盖 API 地址（默认 `http://127.0.0.1:4000`）。web 没有单测，由 E2E 覆盖。

**评测**：`fixtures/knowledge/`（3 篇合成文档）+ `fixtures/evaluation/cases.json`（12 个 zod 校验的用例：6 可回答、2 生成拒答、4 检索拒答）；`src/evaluation/` 的脚本对测试库灌入 fixtures 后用真实模型打分并写报告。报告不含文档全文、API Key、Authorization 头或完整模型响应。

## 测试策略（关键约定）

- 单元测试 `*.test.ts` 不碰数据库：用 `src/test/fixtures.ts` 的 `FakeEmbeddingProvider`（SHA-256 哈希生成确定性 1024 维单位向量，相同文本距离必为 0）与 `FakeAnswerProvider`，通过 `src/test/test-app.ts` 的 `createTestApp()` 构建 App（内部固定指向测试库配置）。
- 集成测试 `*.integration.test.ts` 用真实测试库，配置强制串行（`fileParallelism: false, maxWorkers: 1`），运行前必须先 `db:test:reset`。
- E2E 只与自起的 Fake API（:4100）和 Vite（:5173）交互，绝不复用开发服务器；Playwright `workers: 1`，trace 仅失败时保留。`npm run verify` 与 E2E 均不调用真实 DeepSeek。

## 代码约定

- 全部注释、用户可见文案、测试描述均使用**中文**，请保持一致。
- 纯 ESM：`"type": "module"`，相对导入必须带 `.js` 扩展名；类型导入用 `import type`（`verbatimModuleSyntax`）；strict TS、ES2023、`erasableSyntaxOnly`（禁用 enum/namespace）。
- SQL 内联在 service 里，snake_case 列名，`$n` 参数占位，时间用 `timestamptz`。
- lint 用 oxlint（配置在 `.oxlintrc.json`，react 插件，`rules-of-hooks` 为 error）。
