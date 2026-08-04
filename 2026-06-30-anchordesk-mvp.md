# AnchorDesk MVP 开发说明书

> 状态：已完成产品决策，可进入开发
>
> 最后更新：2026-07-13
>
> 目标读者：项目开发者与后续接手的编码代理

## 1. MVP 目标、边界与非目标

### 1.1 项目目标

AnchorDesk 是一个本地运行的中文 RAG 客服知识库。

项目用于学习 React、Fastify、PostgreSQL、pgvector、Embedding、检索、结构化生成、自动化测试和 RAG 评测。

MVP 必须展示一条完整链路：

1. 录入中文知识文档。
2. 切块并使用 Ollama bge-m3 生成向量。
3. 将文档和向量写入 PostgreSQL 与 pgvector。
4. 对中文问题执行向量检索。
5. 使用 DeepSeek deepseek-v4-pro 生成有引用的回答。
6. 在证据不足或回答不合格时确定性拒答。
7. 保存不可变的问答日志和证据快照。
8. 将拒答与负面反馈汇总到待处理队列。

### 1.2 运行边界

- 仅供开发者本人在本机运行。
- 仅允许使用合成数据或公开数据。
- API、Web 和 PostgreSQL 只绑定回环地址。
- 不支持局域网访问或公网访问。
- 不实现用户、登录、角色、权限和多租户。
- DeepSeek 会接收当前问题和检索片段；不得录入真实客户隐私或公司机密。

### 1.3 语言边界

- UI、合成知识库、评测问题、固定提示和 README 以中文为主。
- 技术名词、包名、模型名、API 字段和代码标识保持英文。
- MVP 不承诺中英双语检索质量。
- 多语言评测属于 MVP 后的增强项。

### 1.4 非目标

以下内容明确不属于 MVP：

- 多轮对话、上下文追问和会话记忆。
- 查询改写、历史压缩和 conversational RAG。
- PDF、Office、网页抓取和 OCR。
- 流式回答、语音输入和移动端专项适配。
- 后台索引任务、任务队列和分布式处理。
- 自动重试、自动修复知识缺口和相似问题去重。
- 生产级安全、审计合规、限流、备份和灾难恢复。
- 将真实 API 部署到 GitHub Pages 或其他公网服务。

### 1.5 MVP 成功标准

满足以下条件才可以称为 MVP 完成：

- 文档创建、列表、查看、编辑和删除均可在 UI 中完成。
- 创建和编辑只有在文档与向量全部写入后才返回成功。
- 每个非拒答答案至少含一个通过后端校验的行内引用。
- 检索不足、空答案或引用不合格都会返回结构化拒答。
- 文档编辑或删除后，历史日志仍能展示当时使用的证据。
- 拒答和 Not helpful 反馈会进入统一的待处理队列。
- 固定中文评测集全部通过。
- lint、类型检查、单元测试、集成测试、端到端测试和构建全部通过。
- 真实 Ollama 与 DeepSeek 的手工端到端流程通过。

## 2. 核心产品合同

### 2.1 单轮问答合同

每次提问都是独立请求。

- 请求不携带 sessionId。
- 后端不读取历史问题或历史回答。
- 数据库不创建 chat_sessions 或 chat_messages。
- UI 可以展示当前页面内最近的结果，但它们不参与后续检索。
- 持久化问答历史统一由 question_logs 表承担。

推荐端点：

~~~text
POST /api/questions
~~~

请求：

~~~json
{
  "question": "退款申请期限是多少？"
}
~~~

问题去除首尾空白后长度必须为 1 至 2000 个字符。

### 2.2 文档合同

支持两种输入方式：

- 在文本框中粘贴内容。
- 在浏览器中选择 .md 或 .txt 文件。

限制：

- 标题去除首尾空白后长度为 1 至 120 个字符。
- 正文去除首尾空白后不得为空。
- 正文 UTF-8 字节数不得超过 100 KB。
- sourceType 只能为 markdown 或 text。
- .md 映射为 markdown，.txt 映射为 text。

创建与编辑必须同时完成文档保存和向量索引。

删除文档会删除当前文档和 chunks，但不能删除历史问答中的证据快照。

MVP 不提供单独的重新索引端点或按钮。

### 2.3 生成结果合同

DeepSeek 必须返回可校验的 JSON 对象：

~~~json
{
  "answer": "退款申请需要在购买后 7 天内提交。[1]",
  "supported": true,
  "citationRanks": [1]
}
~~~

后端使用 Zod 校验结构，并执行以下业务校验：

1. supported 必须为 true。
2. answer 去除空白后不得为空。
3. answer 至少包含一个形如 [1] 的行内引用。
4. 每个引用编号都必须是本次通过距离门槛的检索结果。
5. citationRanks 必须是非空、去重后的正整数数组。
6. citationRanks 必须与 answer 中解析出的引用编号一致。
7. 引用编号不得越界，也不得引用未通过门槛的候选。

任何一项失败都不能作为普通答案返回。

### 2.4 Citation 响应合同

共享类型至少包含：

~~~ts
export type Citation = {
  rank: number;
  documentTitle: string;
  preview: string;
  distance: number;
};

export type QuestionResponse =
  | {
      questionLogId: string;
      answer: string;
      refused: false;
      citations: [Citation, ...Citation[]];
    }
  | {
      questionLogId: string;
      answer: "知识库中没有足够依据回答这个问题。";
      refused: true;
      refusalReason: RefusalReason;
      citations: [];
    };
~~~

非拒答响应只返回实际被答案引用的证据卡片。

完整 chunk 内容只保存在本地数据库日志中，不通过普通问答响应返回浏览器。

### 2.5 拒答合同

拒答分为两级。

检索级拒答：

- 数据库中没有 chunk，原因是 no_chunks。
- 没有候选通过距离门槛，原因是 low_similarity。

生成级拒答：

- DeepSeek 声明 supported 为 false，原因是 model_refused。
- DeepSeek 返回空 answer，原因是 empty_answer。
- JSON 结构无法通过校验，原因是 invalid_model_output。
- 行内引用或 citationRanks 无效，原因是 invalid_citation。

用户统一看到：

~~~text
知识库中没有足够依据回答这个问题。
~~~

拒答响应的 citations 必须为空。

低相似度候选只写入管理日志，不向普通问答界面展示。

不得再用英文正则表达式猜测模型是否拒答。

### 2.6 外部服务错误合同

外部服务故障不属于知识不足，不得写成拒答。

- Ollama 连接失败返回 502。
- DeepSeek 连接失败返回 502。
- 外部调用超时返回 504。
- 请求数据不合法返回 400。
- 资源不存在返回 404。
- 对同一回答重复提交反馈返回 409。

前端必须展示可理解的中文错误，并允许用户手动重试。

外部服务错误写入 Fastify 结构化日志，但不进入 Review Queue。

### 2.7 不可变日志合同

每个完成的问答都写入 question_logs。

日志保存：

- 原始问题与最终回答。
- 是否拒答和结构化拒答原因。
- DeepSeek 模型名和 Embedding 模型名。
- topK、距离门槛和 promptVersion。
- 检索耗时和生成耗时。
- 创建时间。

每个检索候选都写入 question_log_hits 快照。

快照保存：

- 当时的文档 ID 和 chunk ID，仅作为值保存，不建立级联外键。
- 当时的文档标题和完整 chunk 内容。
- rank、distance、是否通过门槛和是否被引用。

日志只读。

文档编辑或删除后，不重算、不修改、不删除历史快照。

### 2.8 Feedback 与 Review Queue 合同

只有非拒答回答可以提交反馈。

每个 questionLogId 最多提交一次反馈。

反馈值只能为 helpful 或 not_helpful。

- helpful 只写入 feedback。
- not_helpful 同时写入 feedback，并创建 Review Queue 项。
- 拒答自动创建 Review Queue 项，但不显示反馈按钮。
- 对拒答日志提交 feedback 返回 409。

Review Queue 项包含：

- itemType：refusal 或 not_helpful。
- status：open 或 resolved。
- 对应 questionLogId。
- 管理备注。
- 创建时间和解决时间。

管理员可以填写备注并手动标记 resolved。

MVP 不自动重新提问、不自动验证新增文档，也不自动关闭队列项。

## 3. 架构、数据流与文件地图

### 3.1 技术栈

- Node.js 20.19 或更高的 20.x 版本。
- npm workspaces。
- React 19、TypeScript 6、Vite 8。
- Tailwind CSS 4。
- Fastify 5、@fastify/cors 11、pg 8、dotenv 17、Zod 4。
- PostgreSQL 16、pgvector。
- Ollama bge-m3。
- DeepSeek deepseek-v4-pro，关闭 thinking。
- tsx 4、Vitest 4、Fastify inject。
- @playwright/test 1.61.x 与 Chromium。

依赖安装后必须提交 package-lock.json。

依赖归属：

- 根 devDependencies：oxlint、@playwright/test。
- API dependencies：fastify、@fastify/cors、pg、dotenv、zod、@anchordesk/shared。
- API devDependencies：typescript、tsx、vitest、@types/node、@types/pg。
- Web dependencies：现有 React 依赖、Tailwind CSS、@tailwindcss/vite、@anchordesk/shared。
- Shared devDependencies：typescript、oxlint。

不要在说明书中复制未来可能过期的完整 package.json。

packages/shared 必须构建到 dist，并从 dist 导出声明。

API 和 Web 只使用 type-only import 引用共享合同。

根 dev、typecheck 和 build 脚本必须先构建 shared，避免依赖未生成的 dist。

### 3.2 运行架构

~~~text
React Web
   |
   | /api 代理
   v
Fastify API
   |------ PostgreSQL + pgvector
   |------ Ollama bge-m3
   |------ DeepSeek Chat Completions
~~~

### 3.3 文档数据流

~~~text
输入文档
  -> 校验标题、类型与 100 KB 上限
  -> 段落感知切块
  -> 批量为全部 chunks 调用 Ollama
  -> 校验每个向量为 1024 维
  -> 在一个事务中写入文档与 chunks
~~~

任何一步失败，创建不落库，更新保持旧版本不变。

### 3.4 问答数据流

~~~text
中文问题
  -> 生成问题向量
  -> pgvector topK 检索
  -> 保存全部候选信息
  -> 按距离门槛筛选
  -> 无可用证据则拒答
  -> DeepSeek 输出结构化 JSON
  -> 校验 supported、答案和引用
  -> 在事务中保存日志、证据快照与 Review Queue
  -> 返回答案或固定拒答
~~~

### 3.5 Provider 接口

外部模型必须通过接口注入，路由和服务不得直接依赖 fetch。

~~~ts
export interface EmbeddingProvider {
  embedOne(input: string, signal?: AbortSignal): Promise<number[]>;
  embedMany(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface AnswerProvider {
  generate(
    question: string,
    evidence: RetrievedChunk[],
    signal?: AbortSignal
  ): Promise<string>;
}
~~~

生产环境使用 OllamaEmbeddingProvider 和 DeepSeekAnswerProvider。

测试使用确定性的 FakeEmbeddingProvider 和 FakeAnswerProvider。

AnswerProvider 只返回模型的原始文本。

JSON.parse、Zod 和引用合同都由 answer-contract.ts 负责，因此非 JSON 输出也能被稳定归类为 invalid_model_output。

### 3.6 目录结构

~~~text
AnchorDesk/
  apps/
    api/
      src/
        app.ts
        server.ts
        config.ts
        db/
          pool.ts
          migrate.ts
          wait-for-db.ts
          reset-test-db.ts
        providers/
          types.ts
          ollama.ts
          deepseek.ts
        rag/
          chunk.ts
          retrieve.ts
          prompt.ts
          answer-contract.ts
        services/
          document-service.ts
          question-service.ts
          review-service.ts
        routes/
          health.ts
          documents.ts
          questions.ts
          logs.ts
          feedback.ts
          review-queue.ts
        test/
          fixtures.ts
          test-app.ts
    web/
      src/
        App.tsx
        api/
          client.ts
        components/
        pages/
          QuestionPage.tsx
          DocumentsPage.tsx
          LogsPage.tsx
          ReviewQueuePage.tsx
  packages/
    shared/
      package.json
      tsconfig.json
      src/
        types.ts
  db/
    migrations/
      001_init.sql
  fixtures/
    knowledge/
      refunds.md
      shipping.md
      support.md
    evaluation/
      cases.json
  e2e/
    anchordesk.spec.ts
  docs/
    index.html
    assets/
  docker-compose.yml
  tsconfig.base.json
  .env.example
  README.md
~~~

测试文件与被测模块就近放置。

上面的 test 目录只保存共享测试辅助代码。

### 3.7 外部接口基线

以下官方合同已于 2026-07-13 核对：

- DeepSeek 模型列表：https://api-docs.deepseek.com/api/list-models/
- DeepSeek Thinking Mode：https://api-docs.deepseek.com/guides/thinking_mode/
- DeepSeek JSON Output：https://api-docs.deepseek.com/guides/json_mode/
- Ollama Embed API：https://docs.ollama.com/api/embed
- Ollama bge-m3：https://ollama.com/library/bge-m3
- GitHub Pages 定位：https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages

实现开始时再次核对这些页面。

若官方请求合同发生变化，先更新说明书和序列化测试，不得静默改变业务合同。

## 4. 工作区、本地安全边界与环境配置

### 4.1 工作区迁移

现有根目录 Vite 应用移动到 apps/web。

根 package.json 改为 npm workspace，包含 apps/* 和 packages/*。

现有 .oxlintrc.json 保留在根目录，供三个 workspace 共用。

现有脚手架通过 @rolldown/plugin-babel 直接启用可选 React Compiler，但该桥接包要求 Node 22.12 或更高版本，与本项目 Node 20.x 基线冲突。Task 1 移除直接的 React Compiler 配置与依赖，保留 React 19、Vite 8 和页面行为。

@vitejs/plugin-react 自身发布的 optional peer 元数据可能继续出现在 package-lock.json 的解析记录中。验收以 npm ls @rolldown/plugin-babel --all 为空且 npm ci 不产生 EBADENGINE 警告为准，不能只按 lockfile 中是否出现包名判断实际安装状态。

移动后立即运行现有 Web 的 lint、类型检查和 build，确认迁移没有破坏脚手架。

### 4.2 根脚本

根 package.json 至少提供：

~~~json
{
  "scripts": {
    "dev:api": "npm run build -w @anchordesk/shared && npm run dev -w @anchordesk/api",
    "dev:web": "npm run build -w @anchordesk/shared && npm run dev -w @anchordesk/web",
    "migrate": "npm run migrate -w @anchordesk/api",
    "migrate:test": "npm run migrate:test -w @anchordesk/api",
    "db:test:wait": "npm run db:test:wait -w @anchordesk/api",
    "db:test:reset": "npm run db:test:reset -w @anchordesk/api",
    "lint": "npm run lint -w @anchordesk/shared && npm run lint -w @anchordesk/api && npm run lint -w @anchordesk/web",
    "typecheck": "npm run typecheck -w @anchordesk/shared && npm run build -w @anchordesk/shared && npm run typecheck -w @anchordesk/api && npm run typecheck -w @anchordesk/web",
    "test": "npm run test -w @anchordesk/api",
    "test:integration": "npm run db:test:reset && npm run test:integration -w @anchordesk/api",
    "test:e2e": "npm run db:test:reset && playwright test",
    "build": "npm run build -w @anchordesk/shared && npm run build -w @anchordesk/api && npm run build -w @anchordesk/web",
    "eval:retrieval": "npm run db:test:reset && npm run eval:retrieval -w @anchordesk/api",
    "eval:generation": "npm run db:test:reset && npm run eval:generation -w @anchordesk/api",
    "verify": "npm run lint && npm run typecheck && npm run test && npm run test:integration && npm run test:e2e && npm run build"
  }
}
~~~

脚本在实现时可以调整，但最终必须保留等价的一键验证入口。

### 4.3 环境文件

唯一的开发环境文件位于仓库根目录。

~~~text
PORT=4000
WEB_ORIGIN=http://127.0.0.1:5173
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5434/anchordesk
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/anchordesk_test
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBED_MODEL=bge-m3
OLLAMA_TIMEOUT_MS=30000
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_TIMEOUT_MS=60000
RAG_TOP_K=5
RAG_MAX_DISTANCE=0.55
PROMPT_VERSION=v1
~~~

apps/api/src/config.ts 必须显式解析仓库根目录的 .env。

不得依赖 workspace 脚本的当前工作目录寻找 .env。

使用 Zod 校验配置。

启动时发现空 API Key、无效 URL、NaN、负数超时或非法 topK 时立即失败，并输出不含密钥的错误。

server.ts 调用 loadConfig(process.env)，此时必须校验非空 DeepSeek Key。

buildApp 接收已构造的 AppConfig 和 Providers，不在内部读取 process.env。

测试直接注入内存 AppConfig 与 Fake Providers，因此不需要真实 DeepSeek Key。

迁移、测试库等待和重置脚本只读取数据库配置，不校验模型配置。

0.55 只是初始门槛，不是最终验收值。

最终值必须根据固定评测集校准。

### 4.4 本地绑定

- Fastify 监听 127.0.0.1。
- Vite 监听 127.0.0.1。
- PostgreSQL 映射为 127.0.0.1:5434:5432。
- CORS 只接受 WEB_ORIGIN。
- 开发 Web 通过 Vite /api 代理访问 Fastify。
- 不使用 origin: true。

### 4.5 Docker Compose

开发和测试 PostgreSQL 都使用 pgvector/pgvector:pg16。

Compose 必须包含：

- postgres：127.0.0.1:5434 映射到容器 5432、anchordesk 数据库、持久化卷和 healthcheck。
- postgres-test：127.0.0.1:5433、anchordesk_test 数据库、tmpfs 和 healthcheck。

开发库宿主端口使用 5434，是为了避免与开发者本机已有的 PostgreSQL 5432 服务冲突；不得停止或复用该外部服务。

db:test:wait 使用 pg 轮询 SELECT 1，最长等待 30 秒。

db:test:reset 先等待测试库，再重建 public schema，并对 TEST_DATABASE_URL 重新执行迁移。

集成测试、Playwright 和检索评测分别在运行前重置测试库，禁止复用上一套测试留下的文档或假向量。

测试数据库工具必须拒绝以下情况：

- TEST_DATABASE_URL 与 DATABASE_URL 完全相同。
- 测试 URL 的数据库名不以 _test 结尾。
- 测试 URL 不是回环地址。

## 5. 数据库及不可变日志模型

### 5.1 迁移规则

创建 schema_migrations 表记录已执行迁移。

每个迁移只执行一次。

迁移按文件名排序，并在事务中执行。

不得在每次启动时无条件重放全部 SQL。

### 5.2 documents

~~~sql
documents (
  id uuid primary key,
  title text not null,
  content text not null,
  source_type text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  indexed_at timestamptz not null
)
~~~

source_type 通过 CHECK 限制为 markdown 或 text。

### 5.3 document_chunks

~~~sql
document_chunks (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1024) not null,
  created_at timestamptz not null,
  unique (document_id, chunk_index)
)
~~~

为 embedding 创建使用 vector_cosine_ops 的 HNSW 索引。

### 5.4 question_logs

~~~sql
question_logs (
  id uuid primary key,
  question text not null,
  answer text not null,
  refused boolean not null,
  refusal_reason text,
  answer_model text not null,
  embedding_model text not null,
  rag_top_k integer not null,
  rag_max_distance double precision not null,
  prompt_version text not null,
  retrieval_ms integer not null,
  generation_ms integer,
  created_at timestamptz not null
)
~~~

refusal_reason 只能是已定义的 RefusalReason 或 null。

检索级拒答的 generation_ms 为 null。

### 5.5 question_log_hits

~~~sql
question_log_hits (
  id uuid primary key,
  question_log_id uuid not null references question_logs(id) on delete cascade,
  source_document_id uuid not null,
  source_chunk_id uuid not null,
  document_title text not null,
  chunk_content text not null,
  rank integer not null,
  distance double precision not null,
  passed_threshold boolean not null,
  cited boolean not null,
  unique (question_log_id, rank)
)
~~~

source_document_id 和 source_chunk_id 不建立到当前文档表的外键。

这是有意的历史快照设计。

### 5.6 feedback

~~~sql
feedback (
  id uuid primary key,
  question_log_id uuid not null unique references question_logs(id) on delete cascade,
  rating text not null,
  created_at timestamptz not null
)
~~~

rating 通过 CHECK 限制为 helpful 或 not_helpful。

### 5.7 review_queue

~~~sql
review_queue (
  id uuid primary key,
  question_log_id uuid not null references question_logs(id) on delete cascade,
  item_type text not null,
  status text not null,
  note text,
  created_at timestamptz not null,
  resolved_at timestamptz,
  unique (question_log_id)
)
~~~

item_type 只能是 refusal 或 not_helpful。

status 只能是 open 或 resolved。

### 5.8 数据库不变量与审计保护

数据库迁移必须建立以下不变量：

- question_logs 的 refused 与 refusal_reason 是否为空必须一致。
- no_chunks 和 low_similarity 的 generation_ms 必须为空。
- 其他生成级拒答和普通回答的 generation_ms 必须大于或等于 0。
- rag_top_k 必须在 1 至 20 之间。
- retrieval_ms 和 distance 不得为负数，rank 必须从 1 开始。
- question_log_hits 的 cited 为 true 时，passed_threshold 必须为 true。
- review_queue 为 open 时 resolved_at 必须为空。
- review_queue 为 resolved 时 resolved_at 必须非空。

question_logs 和 question_log_hits 创建后不允许 UPDATE 或 DELETE。

迁移通过触发器阻止这两个表的修改和删除。

测试清理使用重建测试 schema，不逐行删除审计日志。

### 5.9 数据库事务边界

以下操作必须使用事务：

- 创建文档和插入全部 chunks。
- 更新文档和替换全部 chunks。
- 保存问答日志和全部证据快照。
- 保存拒答日志和创建 refusal 队列项。
- 保存 not_helpful 反馈和创建队列项。

事务中不得执行 Ollama 或 DeepSeek 网络调用。

网络调用必须先完成，数据库事务只负责最终一致性写入。

## 6. 切块、Embedding、检索与固定评测集

### 6.1 切块

MVP 采用确定性的段落感知切块。

- 统一换行为 LF。
- 使用一个或多个空行分隔段落。
- 默认最大长度为 900 个字符。
- 超长段落按字符窗口切分。
- 不做 overlap。
- 空文档返回空数组，并由上层验证拒绝保存。

测试至少覆盖：

- 多段文本。
- CRLF。
- 超长单段。
- 连续空行。
- 中文标点。
- 空白输入。

### 6.2 Ollama Provider

使用 POST /api/embed。

请求模型来自 OLLAMA_EMBED_MODEL。

Provider 必须：

- 使用 AbortController 实现超时。
- 单个问题使用 embedOne。
- 文档 chunks 使用 embedMany，一次请求返回等长向量数组。
- 检查 HTTP 状态。
- 接受 embeddings[0]，兼容旧的 embedding 字段。
- 检查数组非空。
- 检查批量响应数量与输入数量一致。
- 检查所有值为有限数。
- 检查维度严格等于 1024。
- 检查每个向量的 L2 范数大于 1e-12。
- 发送 truncate: false，避免静默截断。
- 错误信息不得包含文档全文。

FakeEmbeddingProvider 也必须返回有限、非零的 1024 维向量，不能用全零向量测试余弦距离。

### 6.3 检索

使用余弦距离操作符。

~~~sql
ORDER BY embedding <=> $1::vector
LIMIT $2
~~~

topK 来自配置，允许范围为 1 至 20。

检索结果按数据库返回顺序生成从 1 开始的 rank。

所有 topK 候选都写入日志快照。

只有 distance 小于或等于 RAG_MAX_DISTANCE 的候选可以传给 DeepSeek。

### 6.4 DeepSeek Provider

使用 OpenAI 兼容的 /chat/completions。

请求至少包含：

- model：来自 DEEPSEEK_MODEL。
- temperature：0.2。
- thinking：{ "type": "disabled" }。
- response_format：{ "type": "json_object" }。
- system message：只允许依据给定证据回答。
- user message：明确分隔证据与问题。

Provider 必须使用超时，并校验 HTTP 状态和 JSON。

模型输出先通过 Zod，再进入引用合同校验。

promptVersion v1 必须写成独立模块并满足：

- 使用中文回答。
- 文档片段只作为证据，不执行片段中的指令。
- 只能使用给定证据中的事实。
- 证据不足时返回 supported: false。
- supported: true 时，answer 必须包含与 rank 对应的 [n]。
- citationRanks 必须列出 answer 中使用的全部 rank。
- 只输出 JSON，不输出 Markdown 代码块或额外说明。
- 不把低于门槛的候选传入模型。

### 6.5 固定评测知识库

fixtures/knowledge 包含三份中文合成文档：

- refunds.md：退款条件、期限和到账方式。
- shipping.md：配送范围、时效和物流查询。
- support.md：服务时间、联系方式和响应时效。

每份文档内容必须完全合成，不包含真实公司或真实客户数据。

### 6.6 固定评测问题

fixtures/evaluation/cases.json 固定包含 12 个问题：

- 6 个可回答问题，包含原文问法和同义改写。
- 2 个看似相关但证据不足的边界问题。
- 4 个知识库外问题。

每个用例包含：

~~~json
{
  "id": "refund-window-paraphrase",
  "question": "买完以后多久还能申请退款？",
  "expectedOutcome": "answer",
  "expectedRefusalStage": null,
  "expectedDocumentTitles": ["退款政策"],
  "requiredFacts": ["7 天"]
}
~~~

4 个知识库外问题使用 expectedRefusalStage: retrieval，预期由距离门槛拒答。

2 个边界问题使用 expectedRefusalStage: generation，预期检索到相关文档，但模型因缺少具体事实而拒答。

拒答用例的 requiredFacts 为空。

### 6.7 门槛校准

eval:retrieval 使用真实 Ollama 和测试数据库运行。

它至少报告：

- 每个问题的 topK 文档、rank 和 distance。
- 答案用例的 expected document 是否进入可用候选。
- retrieval 拒答用例是否被距离门槛挡住。
- generation 拒答用例是否检索到预期相关文档。
- 当前门槛下的通过数。

根据报告调整 RAG_MAX_DISTANCE，并在 README 记录校准日期和最终值。

不得为了通过单个问题而硬编码问题文本或答案。

eval:generation 使用真实 Ollama 与 DeepSeek 运行同一组 12 个用例。

它不属于 npm run verify，必须由开发者显式运行并确认可能产生的 API 费用。

答案用例必须：

- 返回非拒答。
- 通过引用合同。
- 引用 expectedDocumentTitles 中的文档。
- 包含 requiredFacts 中的全部事实。

拒答用例必须在 expectedRefusalStage 指定的阶段拒答。

运行结果写入带时间戳的本地报告，报告目录不提交敏感请求头或 API Key。

## 7. 原子文档 CRUD

### 7.1 API

~~~text
GET    /api/documents
GET    /api/documents/:id
POST   /api/documents
PUT    /api/documents/:id
DELETE /api/documents/:id
~~~

不提供 /reindex。

所有响应字段使用 camelCase。

### 7.2 创建算法

1. 校验 title、content 和 sourceType。
2. 在内存中切块。
3. 使用 embedMany 批量生成全部向量。
4. 校验全部向量。
5. 获取数据库连接并开始事务。
6. 插入 documents。
7. 插入全部 document_chunks。
8. 提交事务。
9. 返回 id 和 chunkCount。

任一 Embedding 失败时不得创建 documents 行。

任一数据库写入失败时事务回滚。

### 7.3 更新算法

1. 检查文档是否存在。
2. 校验新内容。
3. 在事务外使用 embedMany 为新内容生成全部 chunks 和向量。
4. 开始事务。
5. 使用 id 和 expectedUpdatedAt 条件更新 documents。
6. 删除当前 chunks。
7. 插入新 chunks。
8. 提交事务。

失败时旧 documents 和旧 chunks 必须保持一致且继续可用。

条件 UPDATE 必须在事务内执行，并检查 rowCount。

rowCount 为 0 时立即回滚并返回 409，不能继续删除 chunks。

### 7.4 并发边界

MVP 是单用户本地应用。

UI 保存期间禁用按钮，避免正常操作产生并发更新。

API 仍使用 documents.updated_at 进行乐观检查。

更新请求携带 expectedUpdatedAt。

时间戳不一致时返回 409，提示重新加载文档。

### 7.5 删除

DELETE 返回 204。

不存在的文档返回 404。

UI 必须二次确认。

删除后当前 chunks 级联删除，历史 question_log_hits 快照保留。

### 7.6 文档集成测试

至少覆盖：

- 创建成功。
- 标题为空。
- 正文为空。
- sourceType 非法。
- 正文超过 100 KB。
- Embedding 失败时创建不落库。
- 更新 Embedding 失败时旧版本保持不变。
- 更新成功时正文和 chunks 同时变化。
- expectedUpdatedAt 冲突返回 409。
- 删除后当前 chunks 消失。
- 删除后历史日志快照仍存在。

## 8. 问答、结构化生成与反馈流程

### 8.1 API

~~~text
POST /api/questions
GET  /api/logs
GET  /api/logs/:id
POST /api/feedback
GET  /api/review-queue
PUT  /api/review-queue/:id/resolve
~~~

### 8.2 问答服务

QuestionService 负责完整编排。

1. 校验问题。
2. 生成问题向量。
3. 检索 topK。
4. 执行检索级拒答判断。
5. 调用 AnswerProvider。
6. 执行结构与引用校验。
7. 生成普通答案或固定拒答。
8. 在事务中保存日志、hits 和可能的 refusal 队列项。
9. 返回 QuestionResponse。

路由只负责 HTTP 输入输出，不包含 RAG 业务判断。

### 8.3 日志 API

GET /api/logs 返回最近 100 条摘要。

摘要包含：

- 问题和答案预览。
- 是否拒答和原因。
- 创建时间。
- feedback rating。

GET /api/logs/:id 返回：

- 完整问题与答案。
- 模型与 RAG 配置。
- 耗时。
- 全部证据快照。
- 每个候选是否通过门槛和是否被引用。
- feedback。

### 8.4 Feedback API

请求：

~~~json
{
  "questionLogId": "uuid",
  "rating": "not_helpful"
}
~~~

必须验证 questionLogId 存在且对应非拒答回答。

对同一日志的第二次反馈返回 409。

not_helpful 的 feedback 与 Review Queue 创建必须在同一事务中完成。

### 8.5 Review Queue API

GET /api/review-queue 返回 open 项在前、之后按创建时间倒序。

每项包含：

- itemType 和 status。
- 原始问题与回答。
- 拒答原因或 feedback。
- note、createdAt 和 resolvedAt。

解决请求：

~~~json
{
  "note": "已补充退款到账时效说明。"
}
~~~

note 最长 1000 个字符。

解决成功后设置 status 为 resolved 和 resolvedAt。

已解决项再次解决返回 409。

### 8.6 问答与反馈测试

至少覆盖：

- no_chunks 拒答。
- low_similarity 拒答。
- supported 为 false。
- 空答案。
- 非 JSON 输出。
- 无引用、越界引用和引用列表不一致。
- 合法答案与合法引用。
- 拒答响应不返回 citations。
- 日志保存全部 topK 候选。
- 历史快照在文档变化后不变。
- refusal 自动进入 Review Queue。
- helpful 不进入 Review Queue。
- not_helpful 进入 Review Queue。
- 拒答日志不能提交 feedback。
- 重复反馈返回 409。
- resolved 写入 note 和时间。

## 9. 中文前端页面

### 9.1 页面结构

主导航包含：

- 问答
- 知识文档
- 运行日志
- 待处理

MVP 使用页面级组件，不把全部功能继续堆在一个 App.tsx。

App.tsx 只负责布局、导航和页面切换。

### 9.2 问答页面

页面包含：

- 问题输入框。
- 提交按钮。
- loading 状态。
- 普通答案或固定拒答卡片。
- 行内引用。
- 被引用证据卡片。
- 非拒答回答显示 Helpful 和 Not helpful 按钮。

提交期间禁用输入和按钮。

提交反馈后禁用两个反馈按钮并显示结果。

拒答时不显示反馈按钮或低相似度证据。

### 9.3 知识文档页面

页面包含：

- 文档列表。
- 新建和编辑表单。
- .md 与 .txt 文件选择器。
- 标题、类型、更新时间和 chunk 数。
- 保存期间状态。
- 删除按钮和确认对话框。

前端提前检查 100 KB 上限，但后端仍必须重复校验。

### 9.4 运行日志页面

左侧展示最近日志。

右侧展示：

- 问题和回答。
- 拒答原因。
- 模型、topK、距离门槛和 promptVersion。
- 检索与生成耗时。
- 不可变的证据快照。
- 通过门槛和实际引用标记。
- feedback。

### 9.5 待处理页面

页面展示：

- refusal 或 not_helpful 类型。
- 原始问题和回答。
- 当前状态。
- 管理备注。
- 标记解决按钮。

open 项优先显示。

### 9.6 通用交互要求

- 所有表单控件有中文 label。
- 所有按钮显式设置 type。
- 错误区域使用 aria-live。
- 键盘可访问主要操作。
- 列表提供空状态。
- 异步操作提供 loading 和 disabled 状态。
- 事件类型使用 type-only import，满足 verbatimModuleSyntax。

### 9.7 API Client

统一 fetch 封装负责：

- JSON 请求和响应。
- 204 响应。
- 读取结构化错误。
- 将网络错误转换为中文 UI 错误。
- 可注入 baseUrl，方便 Playwright。

页面组件不得重复实现 fetch 错误处理。

## 10. 自动化测试与最终验收

### 10.1 单元测试

使用 Vitest。

单元测试不访问 PostgreSQL、Ollama 或 DeepSeek。

覆盖：

- 切块。
- 配置解析。
- 文档输入校验。
- DeepSeek JSON 结构校验。
- 行内引用解析。
- 引用一致性。
- 拒答原因映射。

### 10.2 API 集成测试

使用 Fastify inject 和注入的 Fake Providers。

使用独立 TEST_DATABASE_URL。

每个测试清理自己的数据。

覆盖文档、问答、日志、反馈和 Review Queue 的 HTTP 与事务行为。

### 10.3 数据库集成测试

使用真实 PostgreSQL 与 pgvector。

覆盖：

- 迁移幂等性。
- 1024 维向量写入。
- 余弦距离排序。
- 文档删除级联。
- 日志快照不级联。
- 事务回滚。

### 10.4 Playwright 端到端测试

端到端测试启动 Web 与使用 Fake Providers 的 API。

playwright.config.ts 使用 webServer 数组启动测试 API 和 Web，并等待两者健康后再执行浏览器步骤。

测试 API 使用内存 AppConfig、TEST_DATABASE_URL 和 Fake Providers，不读取真实 DeepSeek Key。

至少包含一条完整流程：

1. 创建中文文档。
2. 提交可回答问题。
3. 验证行内引用和证据卡片。
4. 提交不可回答问题。
5. 验证固定拒答。
6. 对一个回答提交 Not helpful。
7. 在待处理页面查看队列项。
8. 添加备注并标记解决。

### 10.5 真实检索评测

eval:retrieval 使用真实 Ollama bge-m3。

固定 12 个用例必须全部符合预期结果。

最终 RAG_MAX_DISTANCE 由该评测确定。

评测失败时保留报告，不通过调整预期来掩盖问题。

### 10.6 真实端到端手工验收

真实 DeepSeek 只用于显式的 generation 评测和手工验收，避免默认自动测试受网络、费用和模型波动影响。

至少验证：

- 可回答问题返回中文答案和有效引用。
- 边界问题拒答。
- 知识库外问题拒答。
- DeepSeek Key 缺失时 API 启动失败。
- Ollama 停止时 UI 显示上游服务错误，而不是知识拒答。
- 日志显示模型、门槛、耗时和证据。

运行 npm run eval:generation，固定 12 个用例必须全部符合 expectedOutcome、expectedRefusalStage、expectedDocumentTitles 和 requiredFacts。

### 10.7 一键验证

运行前：

~~~powershell
docker compose up -d postgres postgres-test
ollama pull bge-m3
npx playwright install chromium
~~~

然后运行：

~~~powershell
npm run verify
npm run eval:retrieval
npm run eval:generation
~~~

期望：

- lint 通过。
- TypeScript 通过。
- 单元测试通过。
- API 与数据库集成测试通过。
- Playwright 通过。
- API 与 Web build 通过。
- 固定检索评测 12/12 通过。
- 固定生成评测 12/12 通过。

## 11. GitHub Pages 项目介绍页

### 11.1 定位

GitHub Pages 只展示项目，不运行真实应用。

页面不得请求 Fastify API，也不得包含 DeepSeek Key。

### 11.2 内容

docs/index.html 至少包含：

- 中文项目简介。
- MVP 功能列表。
- 架构图。
- 文档索引与问答流程图。
- 问答、文档、日志和待处理页面截图。
- 测试与评测结果摘要。
- 本地运行步骤。
- 指向仓库 README 的链接。

页面明确标注：

~~~text
这是项目介绍页。真实 RAG 功能需要按 README 在本机运行。
~~~

### 11.3 发布边界

- GitHub Pages 从 docs 目录发布。
- 页面可以使用静态 HTML、CSS 和图片。
- 不维护 mock API。
- 不提供预设回答或伪造的交互式 RAG。
- 截图必须来自通过最终验收的本地应用。

## 12. 开发任务清单与完成定义

### Task 1：迁移工作区并固定本地边界

主要文件：

- 根 package.json
- package-lock.json
- tsconfig.base.json
- .gitignore
- .env.example
- apps/web/*

步骤：

- [x] 将现有 Vite 应用移动到 apps/web。
- [x] 建立 npm workspaces。
- [x] 设置 Node engines。
- [x] 增加根脚本。
- [x] 为 shared、api 和 web 分别提供必需的 lint、typecheck 与 build 脚本。
- [x] 必需脚本不得使用 --if-present 跳过缺失命令。
- [x] 保留 React 19 与 Vite 8 Web 依赖，移除不兼容 Node 20.x 的直接 React Compiler 配置和依赖并更新 lockfile。
- [x] 在根目录保留共享 Oxlint 配置。
- [x] 配置 shared 的 declaration build 与 dist exports。
- [x] 增加根 .env.example。
- [x] 修正 .gitignore，忽略 .env、dist、测试产物和日志。
- [x] 让 Web 只监听 127.0.0.1。
- [x] 运行迁移后的 Web lint、typecheck 和 build。

完成定义：

- apps/web 可独立启动。
- 根目录不再保留重复的 Vite 入口文件。
- 当前 Vite 示例页在迁移后仍可构建。

### Task 2：建立 PostgreSQL、pgvector 与迁移系统

主要文件：

- docker-compose.yml
- db/migrations/001_init.sql
- apps/api/src/db/pool.ts
- apps/api/src/db/migrate.ts

步骤：

- [x] 添加只绑定回环地址的 PostgreSQL。
- [x] 添加 healthcheck。
- [x] 创建 postgres 与 postgres-test 两个隔离服务。
- [x] 为测试服务使用 5433 和 tmpfs。
- [x] 创建 schema_migrations。
- [x] 创建最终 schema、约束和索引。
- [x] 实现一次性迁移记录。
- [x] 实现测试库等待、重置和测试迁移脚本。
- [x] 添加迁移与数据库测试。

完成定义：

- 重复运行 migrate 不重复执行 001_init.sql。
- pgvector 扩展和 HNSW 索引存在。
- 开发库与测试库隔离。
- 每个集成测试、E2E 和评测阶段都从干净测试库开始。

### Task 3：建立共享合同与可测试 API 壳

主要文件：

- packages/shared/src/types.ts
- apps/api/src/config.ts
- apps/api/src/app.ts
- apps/api/src/server.ts
- apps/api/src/routes/health.ts
- apps/api/src/providers/types.ts

步骤：

- [x] 创建共享类型。
- [x] 创建 RefusalReason、Citation 和 QuestionResponse。
- [x] 显式加载根 .env 并使用 Zod 校验。
- [x] 分离 buildApp 与 listen。
- [x] 让 buildApp 接收 AppConfig 和 Providers。
- [x] 仅在 server.ts 启动真实服务时强制校验 DeepSeek Key。
- [x] 使用依赖注入装配 Provider。
- [x] 配置精确 CORS。
- [x] 添加 /api/health。
- [x] 添加配置和 health 测试。

完成定义：

- Fastify inject 不需要监听端口即可测试。
- 缺失 DeepSeek Key 时启动失败并给出明确错误。
- API 只监听 127.0.0.1。

### Task 4：实现 RAG 核心与评测夹具

主要文件：

- apps/api/src/rag/chunk.ts
- apps/api/src/rag/retrieve.ts
- apps/api/src/rag/answer-contract.ts
- apps/api/src/providers/ollama.ts
- apps/api/src/providers/deepseek.ts
- fixtures/*

步骤：

- [x] 先编写切块失败测试。
- [x] 实现确定性切块并使测试通过。
- [x] 实现 Ollama Provider、超时和维度校验。
- [x] 实现 pgvector 检索。
- [x] 实现 DeepSeek JSON 输出。
- [x] 实现结构和行内引用校验。
- [x] 建立 3 份文档与 12 个评测用例。
- [x] 实现 eval:retrieval。

完成定义：

- 单元测试覆盖所有引用失败路径。
- Fake Providers 可确定性驱动服务测试。
- 真实 bge-m3 可以完成检索报告。

### Task 5：实现原子文档 CRUD

主要文件：

- apps/api/src/services/document-service.ts
- apps/api/src/routes/documents.ts
- 对应单元与集成测试

步骤：

- [x] 实现输入校验和 100 KB 上限。
- [x] 实现创建前完成全部 Embedding。
- [x] 实现事务化创建。
- [x] 实现事务化更新。
- [x] 实现 expectedUpdatedAt 乐观检查。
- [x] 实现列表、详情和删除。
- [x] 删除独立 reindex 路由。
- [x] 编写失败回滚与快照保留测试。

完成定义：

- 不存在新正文与旧向量混合状态。
- Provider 失败不会破坏当前可用版本。
- 删除文档不破坏历史证据。

### Task 6：实现单轮问答、引用与拒答

主要文件：

- apps/api/src/services/question-service.ts
- apps/api/src/routes/questions.ts
- 对应单元与集成测试

步骤：

- [x] 实现单轮问题输入。
- [x] 实现检索级拒答。
- [x] 实现结构化生成。
- [x] 实现引用一致性校验。
- [x] 实现生成级拒答。
- [x] 保存日志与 hits 快照。
- [x] 拒答时事务化创建队列项。
- [x] 区分知识拒答与上游错误。

完成定义：

- 普通答案总有有效行内引用。
- 所有不合格输出都按明确原因拒答。
- 普通响应不泄露完整 chunk。

### Task 7：实现日志、Feedback 与 Review Queue

主要文件：

- apps/api/src/services/review-service.ts
- apps/api/src/routes/logs.ts
- apps/api/src/routes/feedback.ts
- apps/api/src/routes/review-queue.ts
- 对应集成测试

步骤：

- [x] 实现日志列表和详情。
- [x] 展示不可变 hits 快照。
- [x] 实现单次 feedback。
- [x] 实现 not_helpful 事务。
- [x] 实现队列列表。
- [x] 实现备注和手动解决。
- [x] 实现重复反馈和重复解决的 409。

完成定义：

- Feedback 不再是无法查看的孤立数据。
- refusal 与 not_helpful 都可在待处理列表中追踪。

### Task 8：实现中文 Web UI

主要文件：

- apps/web/src/App.tsx
- apps/web/src/api/client.ts
- apps/web/src/components/*
- apps/web/src/pages/*
- apps/web/src/styles.css

步骤：

- [x] 配置 Tailwind CSS 4。
- [x] 实现中文导航与布局。
- [x] 实现问答页面。
- [x] 实现完整文档 CRUD 页面。
- [x] 实现运行日志页面。
- [x] 实现待处理页面。
- [x] 实现 loading、empty、error 和 disabled 状态。
- [x] 实现反馈提交后的状态。
- [x] 修正所有 type-only import。

完成定义：

- 四个页面均能完成各自核心流程。
- UI 不依赖未定义的未来 API。
- 主要操作可使用键盘完成。

### Task 9：完成自动化测试与 RAG 校准

主要文件：

- apps/api/src/**/*.test.ts
- e2e/anchordesk.spec.ts
- playwright.config.ts
- fixtures/evaluation/cases.json

步骤：

- [ ] 完成单元测试。
- [ ] 完成 Fastify inject 测试。
- [ ] 完成 PostgreSQL 与 pgvector 测试。
- [ ] 完成 Playwright 流程。
- [ ] 配置 Playwright webServer 启动 Fake API 与 Web。
- [ ] 在 README 中加入 npx playwright install chromium。
- [ ] 确认自动测试不访问真实 DeepSeek。
- [ ] 运行真实 Ollama 检索评测。
- [ ] 运行显式的真实 DeepSeek 生成评测。
- [ ] 校准并记录 RAG_MAX_DISTANCE。
- [ ] 让 npm run verify 通过。

完成定义：

- 自动化测试覆盖所有核心合同和失败路径。
- 固定评测集 12/12 通过。
- 生成评测报告不包含 API Key 或请求头。
- 测试可以重复执行而不污染开发数据。

### Task 10：README、Pages 与最终验收

主要文件：

- README.md
- docs/index.html
- docs/assets/*

步骤：

- [ ] 写中文 README。
- [ ] 列出 Node、Docker、Ollama 和 DeepSeek Key 前置条件。
- [ ] 同时给出 PowerShell 与 Bash 的环境文件复制命令。
- [ ] 明确要求填写 DEEPSEEK_API_KEY。
- [ ] 记录本地端口和仅本机边界。
- [ ] 记录固定评测集和最终门槛。
- [ ] 运行真实端到端手工验收。
- [ ] 截取四个页面。
- [ ] 创建不含 API 调用的 Pages 介绍页。
- [ ] 运行最终 verify 和 eval:retrieval。
- [ ] 运行最终 eval:generation。

完成定义：

- 新开发者按 README 可以从空环境启动项目。
- README 不遗漏 API Key、数据库健康和 Ollama 模型步骤。
- Pages 明确只是项目介绍页。
- 所有 MVP 成功标准均有对应证据。

### 最终开发门禁

在声明 MVP 完成前，必须保留以下证据：

- npm run verify 的成功输出。
- npm run eval:retrieval 的 12/12 报告。
- npm run eval:generation 的 12/12 报告。
- 一次真实 DeepSeek 问答与拒答记录。
- 文档更新失败回滚测试。
- 文档删除后日志快照仍可查看的测试。
- Not helpful 进入 Review Queue 的端到端截图。
- 四个中文页面的最终截图。

若任一门禁未通过，只能称为开发中，不得称为 MVP 已完成。
