# AnchorDesk 知识库问答

AnchorDesk 是一个**仅供开发者本人本机运行**的中文 RAG（检索增强生成）知识库问答系统：把中文文档存入本地 PostgreSQL + pgvector，用 Ollama `bge-m3` 做向量检索，由 DeepSeek 依据检索到的证据生成带引用的中文回答，并提供文档管理、问答日志、用户反馈与待处理审核四个页面。

所有服务（Web、API、PostgreSQL、Ollama）都只监听回环地址，**不支持局域网或公网访问**。本项目只允许录入**合成数据或公开数据**，不得录入客户隐私、公司机密或个人敏感信息。

## 一、项目简介

AnchorDesk 演示了一条完整的本地化 RAG 链路：文档分块与向量化 → 相似度检索与距离门槛 → 结构化生成与引用合同校验 → 原子化日志与证据快照 → 反馈与待处理闭环。

系统不会伪造回答：检索不到依据时返回确定性拒答；模型没有足够依据时主动拒答并进入"待处理"；回答中的每条引用都对应一条真实检索到的证据，且可点击定位。

## 二、MVP 功能

- **中文文档管理**：创建、列表、详情、连续编辑（乐观并发版本校验）与删除；自动分块与向量索引；支持 `.md` / `.txt` / `.docx` 文件上传与解析质量门控（`.pdf` 需可选部署 MinerU，含扫描件 OCR）。
- **单轮问答**：中文问题 → 检索 → 生成；答案含行内引用，点击引用可定位到证据卡片（文档标题、内容预览、余弦距离）。
- **确定性拒答**：知识库为空、检索距离超门槛、模型主动拒答、模型输出不合法，均返回固定拒答文案并记录原因。
- **用户反馈**：对普通回答提交"有帮助 / 没有帮助"；反馈提交后按钮锁定；"没有帮助"自动进入待处理队列。
- **待处理审核**：refusal 与 not_helpful 两类项目、备注（1–1000 字）、标记已解决、已解决只读。
- **运行日志**：最近 100 条摘要（不泄露完整正文）、完整详情（模型、Top K、距离门槛、Prompt 版本、耗时）与全部候选 hits 快照（距离、门槛判定、引用状态）。
- **审计快照不可变**：删除或编辑文档不会破坏历史日志中的证据快照。

## 三、技术栈

| 层 | 技术 |
|---|---|
| Web | React 19、Vite 8、Tailwind CSS 4 |
| API | Node.js、Fastify 5、TypeScript |
| 数据库 | PostgreSQL 16 + pgvector（1024 维余弦距离，HNSW 索引） |
| 向量模型 | Ollama `bge-m3` |
| 生成模型 | DeepSeek（chat/completions，结构化 JSON 输出） |
| 文档解析 | 本地 mammoth（docx）+ 可选 MinerU（PDF / 扫描件 OCR，本机 `mineru-api`） |
| 测试 | Vitest（单元 + 集成）、Playwright（浏览器 E2E）、oxlint、TypeScript |

## 四、系统架构

```text
React Web
   │
   ▼
Fastify API ─── Ollama bge-m3
   │
   ├────────── DeepSeek
   │
   ├────────── MinerU（可选：PDF 解析，mineru-api）
   │
   ▼
PostgreSQL + pgvector
```

- **Web**（`127.0.0.1:5173`）：中文管理界面，只与本机 API 通信。
- **API**（`127.0.0.1:4000`）：文档服务（含文件解析与质量门控）、问答编排、反馈与审核、日志查询；验证输入、数据库安全与上游错误映射（502/504）。
- **Ollama**（`127.0.0.1:11434`）：仅在本机提供 `bge-m3` 向量嵌入。
- **MinerU**（可选，`127.0.0.1:8000`）：本机 `mineru-api` 服务，负责 PDF 解析（数字版 + 扫描件 OCR），输出 Markdown。
- **DeepSeek**：仅由 API 调用。它会接收到**当前问题和检索到的证据片段**，用于生成回答或拒答。

## 五、RAG 问答流程

单轮 RAG 流程：

```text
中文问题
 → 生成问题向量
 → pgvector 相似度检索
 → 距离门槛过滤
 → DeepSeek 结构化生成
 → 引用合同校验
 → 回答或确定性拒答
 → 保存日志与证据快照
```

说明：

- **每次提问独立**，不携带会话历史，不存在多轮上下文。
- 距离门槛 `RAG_MAX_DISTANCE=0.45`：门槛内才作为证据交给模型；无门槛内证据时直接拒答。
- 删除或编辑文档不会破坏历史日志的证据快照（快照在提问时固化）。

## 六、本地安全边界

- 项目**仅供开发者本人在本机运行**。
- Web、API、PostgreSQL（开发库 `5434`、测试库 `5433`）、Ollama、MinerU（可选）均只监听回环地址（`127.0.0.1` / `localhost`）。
- **不支持局域网或公网访问**；不要求部署任何公网服务。
- **只允许使用合成数据或公开数据**。DeepSeek 会接收当前问题和检索片段，请勿录入客户隐私、公司机密或个人敏感信息。
- `DEEPSEEK_API_KEY` 只存在于本机 `.env`，`.env` 已被 Git 忽略，**不要提交 `.env`**。
- GitHub Pages 只是静态项目介绍页，不运行真实 RAG，也不访问本机 API。

## 七、环境要求

| 依赖 | 要求 |
|---|---|
| Node.js | `>=20.19.0 <21`（与 npm 一并安装） |
| Docker Desktop | 运行 PostgreSQL + pgvector 容器 |
| Ollama | 本机服务，需保持运行 |
| Ollama 模型 | `bge-m3`（`ollama pull bge-m3`） |
| DeepSeek API Key | 必填，写入 `.env` 的 `DEEPSEEK_API_KEY` |
| MinerU（可选） | 仅 PDF 上传需要：本机 `mineru-api` + `.env` 的 `MINERU_API_URL` |
| Playwright Chromium | 仅 E2E 需要（`npx playwright install chromium`） |

### 环境文件

PowerShell：

```powershell
Copy-Item .env.example .env
```

Bash：

```bash
cp .env.example .env
```

> **必须打开 `.env`，填写 `DEEPSEEK_API_KEY`。不要提交 `.env`。**

### 本地端口

| 服务 | 地址 |
|---|---|
| Web | `127.0.0.1:5173` |
| API | `127.0.0.1:4000` |
| 开发 PostgreSQL | `127.0.0.1:5434` |
| 测试 PostgreSQL | `127.0.0.1:5433` |
| Ollama | `127.0.0.1:11434` |
| MinerU mineru-api（可选） | `127.0.0.1:8000` |

## 八、从空环境启动

按顺序执行：

```powershell
npm ci
docker compose up -d postgres postgres-test
docker compose ps
ollama pull bge-m3
npm run migrate
npx playwright install chromium
```

检查：

- `docker compose ps` 中两个数据库应显示 **healthy**。
- **Ollama 服务必须正在运行**（`ollama list` 能看到 `bge-m3`）。
- `DEEPSEEK_API_KEY` 为空时，API 会**拒绝启动**（快速失败，不泄露配置值）。

如需 PDF 上传（可选，含扫描件 OCR；不部署则 PDF 上传会得到明确的 400 提示）：

```powershell
uv venv D:\envs\mineru --python 3.11
uv pip install --python D:\envs\mineru\Scripts\python.exe torch torchvision --index-url https://download.pytorch.org/whl/cpu
uv pip install --python D:\envs\mineru\Scripts\python.exe -U "mineru[core]" -i https://mirrors.aliyun.com/pypi/simple
D:\envs\mineru\Scripts\mineru-models-download.exe -s modelscope -m pipeline
D:\envs\mineru\Scripts\mineru-api.exe --host 127.0.0.1 --port 8000 --backend pipeline --device cpu
```

- 模型下载约 5–10 GB，仅首次需要；`.env` 中 `MINERU_API_URL` 留空则禁用 PDF 上传。
- 验证：`curl.exe --noproxy "*" http://127.0.0.1:8000/health`。
- 硬件建议 16 GB+ 内存；CPU 解析较慢，单页数秒到数十秒。

然后分别打开两个终端：

终端 1（API）：

```powershell
npm run dev:api
```

终端 2（Web）：

```powershell
npm run dev:web
```

访问：

```text
http://127.0.0.1:5173
```

不要求部署任何公网服务。

## 九、自动测试

```powershell
npm run test              # 单元测试（输入合同、预览、Provider、评估器等）
npm run test:integration  # 集成测试（重置测试数据库 + Fastify inject + PostgreSQL/pgvector）
npm run test:e2e          # 浏览器 E2E（重置测试数据库 + Fake API + Vite Web + Chromium）
npm run verify            # lint + typecheck + test + test:integration + test:e2e + build
npm run lint
npm run typecheck
npm run build
```

说明：

- **`npm run verify` 不调用真实 DeepSeek**。E2E 使用 Fake Embedding/Answer/Extraction Provider 和独立端口 `4100`，绝不触碰开发数据库与真实上游；MinerU 相关用例由 mock HTTP 服务覆盖。
- 单元测试 24 文件 / 205 用例；集成测试 7 文件 / 94 用例；E2E 3 条流程（完整 13 步链路、docx 上传、pdf 上传）。

## 十、RAG 评测

```powershell
npm run eval:retrieval    # 真实本机 Ollama 检索评测（免费）
npm run eval:generation   # 真实 DeepSeek 生成评测（付费，可能产生费用）
```

说明：

- 固定评测集包含 3 篇合成知识文档与 12 个问题：**6 个可回答问题、2 个生成阶段拒答、4 个检索阶段拒答**。
- 两个评测命令都会先重置**测试数据库**，数据在事务中创建、完成后回滚，不会污染开发数据库。
- `eval:retrieval` 调用本机 Ollama `bge-m3`；`eval:generation` 调用真实 DeepSeek，**可能产生 API 费用**。
- 评测报告写入被 Git 忽略的 `reports/`（`reports/retrieval/`、`reports/generation/`），**不包含**文档全文、API Key、Authorization 请求头或完整模型响应。
- 最终门槛：`RAG_MAX_DISTANCE=0.45`。
- 当前结果：检索评测 **12/12**、生成评测 **12/12**。

不要在报告、Issue 或聊天记录中粘贴 API Key、请求头或完整模型响应。

## 十一、常见问题

**Q：API 启动就退出，报"配置无效：DEEPSEEK_API_KEY 不能为空"？**
A：`DEEPSEEK_API_KEY` 未填写。打开 `.env` 填写后重试。

**Q：提问后提示"无法连接本机 API"？**
A：API 未启动或已退出。先在终端 1 运行 `npm run dev:api`。

**Q：提问返回"Ollama 上游服务响应异常 / 请求超时"？**
A：Ollama 服务未运行、`bge-m3` 未拉取或正在冷启动加载。运行 `ollama list` 确认，必要时 `ollama pull bge-m3`。上游错误是明确的系统错误，不会伪装成知识拒答。

**Q：文档保存时提示"文档已被修改，请重新加载最新内容后再保存"？**
A：其他操作更新了该文档，属于乐观并发保护。点击当前文档重新加载最新内容后重新编辑。

**Q：PDF 上传提示"PDF 解析尚未启用"？**
A：本机未部署 MinerU，或 `.env` 的 `MINERU_API_URL` 为空。按第八节的「如需 PDF 上传」部署并启动 `mineru-api` 后即可。这是明确的输入错误，不会伪装成知识拒答。

**Q：上传 .docx / .pdf 后提示"文件内容无法解析"？**
A：文件损坏、内容为空或扫描件 OCR 失败（质量门控拒绝）。检查文件后重试；pdf 可确认 `mineru-api` 正在运行且内存充足。

**Q：为什么拒答没有反馈按钮？**
A：拒答不展示反馈按钮；拒答会自动进入"待处理"页。

**Q：为什么测试数据库与开发数据库分开？**
A：所有测试与评测只使用 `*_test` 数据库并先重置，避免污染开发数据。

## 十二、GitHub Pages 介绍页

`docs/` 目录是一份**纯静态项目介绍页**（含四张页面截图），已通过本地预览检查，**尚未发布**。发布步骤：

1. 创建 GitHub 仓库并配置 remote（`git remote add origin <仓库地址>`）。
2. 推送默认分支。
3. 在 GitHub 仓库 Settings → Pages 中，Source 选择 *Deploy from a branch*，Branch 选择默认分支，Folder 选择 `/docs`。
4. 将 `docs/index.html` 中两处 `OWNER/REPOSITORY` 占位链接替换为真实仓库地址并重新推送。
5. 发布后在本 README 中补充线上地址。

> 这是项目介绍页。真实 RAG 功能需要按 README 在本机运行。

页面不包含任何 API 调用、表单提交或密钥内容。

## 十三、项目结构

```text
AnchorDesk/
├── apps/
│   ├── api/                  # Fastify API（服务、路由、Provider、评测、测试）
│   └── web/                  # React 中文管理界面
├── packages/shared/          # API 与 Web 共享的类型合同
├── db/migrations/            # PostgreSQL + pgvector 迁移
├── fixtures/
│   ├── knowledge/            # 合成评测知识文档（退款/配送/客服）
│   └── evaluation/           # 12 个固定评测用例
├── e2e/                      # Playwright 端到端测试
├── docs/                     # GitHub Pages 静态介绍页
├── playwright.config.ts
├── docker-compose.yml
└── .env.example              # 环境变量样例（复制为 .env）
```

## 十四、MVP 非目标

- 不支持登录、用户、角色或多租户。
- 不支持多轮对话、会话历史、网页导入或流式回答。（PDF 导入已支持，需可选部署 MinerU）
- 不部署 Fastify、PostgreSQL、Ollama、MinerU 或 DeepSeek 到公网。
- 不在 Pages 中模拟或伪造可交互的 RAG。
- 不录入或展示客户隐私、公司机密、个人敏感信息或真实密钥。
