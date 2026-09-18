# PDF/Word 文档解析层设计

> 状态：草案，待评审。本文是 `docs/2026-06-30-anchordesk-mvp.md`（产品合同）的扩展设计，
> 落地后需同步更新产品合同的「文档输入限制」章节、README 与 CLAUDE.md。

日期：2026-09-18

## 一、背景与目标

现状：文档录入只支持 `markdown` / `text` 两种纯文本类型，且文件读取发生在浏览器端
（`DocumentsPage.tsx` 用 `file.text()` 读成字符串后走 JSON 上传），API 不接触二进制。

目标：

1. 支持 PDF（含扫描件，经 OCR）与 Word（.docx）文件录入；
2. 解析层可插拔（Provider 模式），业务管线（分块 → 向量化 → 检索 → 生成）完全复用；
3. 解析质量可验证：用现有检索评测 harness 量化解析层对命中率的影响。

非目标（本期不做）：

- 图片格式（PNG/JPG）独立 OCR 录入（如需，二期以同模式接入 PaddleOCR）；
- PPTX/XLSX 解析；
- 解析结果的人工修订。

## 二、选型评估

约束条件：中文文档为主、服务只监听回环地址（不得引入云 API）、纯 Node 主应用、
Windows 11 本机部署、免费。

| 方案 | 中文质量 | 结构保真 | 部署形态 | 结论 |
|---|---|---|---|---|
| **MinerU** | 第一梯队（中文 Edit Distance 0.310） | 表格/公式(LaTeX)/多栏阅读顺序最强 | 本机 pip 安装，官方 `mineru-api` FastAPI 服务，原生支持 Windows；CPU 可跑（慢） | ✅ **PDF 解析器**（自带 OCR，扫描件同一通路） |
| tesseract.js + mupdf.js | 一般 | 无版面分析，需自拼阅读顺序 | 纯 JS，无 Python | ❌ 中文质量与结构保真不足 |
| PaddleOCR（独立） | 好 | 仅文本行+坐标，无版面/表格/阅读顺序 | pip + PaddleX serving 或 FastAPI 包装 | ⏸ 二期可选（仅当支持图片 OCR 时） |
| Docling (IBM) | 弱（中文 Edit Distance 0.909） | 表格精度高（97.9%） | 纯 Python 本地 | ❌ 中文场景不达标 |
| LlamaParse | 英文为主 | 表格最强 | 云端 API | ❌ 违反回环/本机约束，且付费 |
| Unstructured | 中文弱（0.716） | 一般 | 本地可，但中文优化不足 | ❌ 中文场景不达标 |
| mammoth | — | DOCX 段落/标题提取，中文 OK | 纯 JS npm 包，零配置 | ✅ **DOCX 解析器**（内置，不走侧车） |

决策：

- **PDF → MinerU**（本机 HTTP 侧车服务，模式同 Ollama：用户手动启动，应用只做 HTTP 调用）；
- **DOCX → mammoth**（npm 内置，无外部依赖。不交给 MinerU 的理由：保持 md/txt/docx
  等轻量格式在无 Python 环境下可用，缩小侧车依赖面）；
- **扫描件 OCR 由 MinerU 内部覆盖**（其 OCR 后端即 PaddleOCR 系模型），不单独接 PaddleOCR。

## 三、总体架构

沿用现有 Provider 模式，新增第三类 Provider：

```ts
// apps/api/src/providers/types.ts 扩展
export interface DocumentExtractionProvider {
  /** 把二进制文件解析为 UTF-8 纯文本；提取失败/质量不达标必须抛错 */
  extract(file: { filename: string; mimeType: string; data: Buffer }): Promise<string>;
}

export interface Providers {
  embeddingProvider: EmbeddingProvider;
  answerProvider: AnswerProvider;
  extractionProvider: DocumentExtractionProvider; // 新增
}
```

实现分两类：

- **内置实现 `LocalExtractionProvider`**：按扩展名路由——`.md`/`.txt` 直接 UTF-8 解码；
  `.docx` 用 mammoth 提取；其他扩展名抛「不支持」错误。零网络调用，永远可用。
- **`MinerUExtractionProvider`**：HTTP 调用本机 `mineru-api` 的 `POST /file_parse`，
  取回 Markdown 文本。连接失败/超时复用现有 `ProviderError`（见下）。

选择策略：sourceType 为 `pdf` 时走 MinerU，其余走 Local。Provider 由 `buildApp` 装配，
与 Ollama/DeepSeek 的注入方式一致。

### 错误合同（关键边界）

扩展 `ProviderError` 的 `ProviderName` 增加 `'mineru'`，与现有映射完全对齐：

| 情形 | 状态码 | 响应 code | 进入 Review Queue？ |
|---|---|---|---|
| mineru-api 未启动/连接失败 | 502 | `provider_error` | 否（系统错误） |
| 解析超时 | 504 | `provider_timeout` | 否 |
| 提取结果为空/乱码/质量门控不过 | 400 | `unparseable_document` | 否（输入不合法） |
| `MINERU_API_URL` 未配置时上传 pdf | 400 | `pdf_extraction_disabled` | 否 |
| 不支持的文件类型 | 400 | `unsupported_file_type` | 否 |

原则延续产品合同：**解析失败是系统错误或输入错误，绝不与「知识拒答」混淆**。

### 事务边界

MinerU 调用与 Ollama 嵌入同属外部调用，**必须在事务开始前完成**，事务内只写
documents + chunks 与审计数据。现有 `createDocument` 流程已是「嵌入在前、事务写库在后」，
新流程只需把「提取」放在嵌入之前。

## 四、分阶段数据流

```
Web 端 file input（.md/.txt/.pdf/.docx）
  → multipart 上传 POST /api/documents/upload
  → 路由校验：原始文件 ≤ 10MB、扩展名白名单
  → DocumentService.upload：
       1. extractionProvider.extract(buffer)        # 外部调用（事务外）
       2. 质量门控（见下节）
       3. 复用现有校验：标题 1–120 字、文本 UTF-8 ≤ 100KB
       4. embedMany(chunks)                          # 外部调用（事务外）
       5. 事务写库（documents + document_chunks，一步失败整体回滚）
```

提取后的文本与现有 markdown/text 路径**无任何区别**：同一校验、同一分块、同一嵌入。

## 五、质量门控

对提取结果做三道廉价检测（`extract/quality-gate.ts` 纯函数，便于单测）：

1. **空文本**：去空白后为空 → `unparseable_document`（典型：扫描件且 OCR 失败、损坏文件）；
2. **乱码率**：U+FFFD 替换字符占比 > 1% → 拒绝（编码损坏特征）；
3. **字符密度**：有效字符数 / 文件页数（MinerU 返回元数据）低于阈值 → 疑似漏识别，拒绝。

阈值先取保守值（乱码率 1%），接入真实样本后调优。门控是纯函数，Fake Provider 与
真实 Provider 共享同一套检测，测试无死角。

## 六、数据库与共享类型变更

### 新迁移 `db/migrations/002_document_source_types.sql`

`001_init.sql` 已应用且迁移不可变（sha256 校验和），必须新增迁移文件：

```sql
ALTER TABLE documents DROP CONSTRAINT documents_source_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_type_check
  CHECK (source_type IN ('markdown', 'text', 'pdf', 'docx'));
```

### `packages/shared/src/types.ts`

```ts
export type DocumentSourceType = 'markdown' | 'text' | 'pdf' | 'docx';
```

`sourceType` 语义不变：记录来源格式，正文仍以 UTF-8 纯文本入库（PDF 存 MinerU
输出的 Markdown 文本）。

## 七、API 变更

保留现有 JSON 接口 `POST /api/documents`（粘贴文本仍可用，测试与旧调用方不破坏），
**新增** multipart 路由：

```
POST /api/documents/upload
  multipart/form-data，字段 file（必填，≤ 10MB）
  → 201 { id, title, sourceType, ... }（与现有创建响应一致）
```

- 标题从文件名推断（去掉扩展名），允许用户在 Web 端修改后再提交；
- sourceType 按扩展名映射：`.md→markdown`、`.txt→text`、`.pdf→pdf`、`.docx→docx`；
- 依赖 `@fastify/multipart`，`limits.fileSize = 10MB`（提取文本仍受 100KB 上限约束）；
- 路由保持极薄，只转发到 service。

## 八、Web 变更

`DocumentsPage.tsx`：

- file input `accept` 扩为 `.md,.txt,.pdf,.docx`；
- 改用 FormData 走 upload 路由；纯文本路径（粘贴/手动输入）继续走 JSON 接口；
- 上传前只做文件大小预检（10MB），文本 100KB 校验仍以服务端为准；
- 解析失败时展示服务端返回的中文错误（如「PDF 内容无法识别，请确认不是空扫描件」）。

## 九、配置变更

`.env` 新增两项（**可选**，与现有「全部必填」策略刻意不同——MinerU 是可选能力，
未安装时系统其余功能不受影响）：

```
MINERU_API_URL=http://127.0.0.1:8000   # 留空 = 禁用 PDF 解析
MINERU_TIMEOUT_MS=300000               # CPU 模式解析慢，默认 5 分钟
```

`config.ts` 中这两个字段用可选 schema（空串视为未配置），其余变量维持必填校验不变。

## 十、部署与运维

MinerU 侧车按 Ollama 同等方式对待：一次性手动安装，日常手动启动。

```bash
# 一次性：conda 创建 python=3.10 环境，pip 安装（国内用 modelscope 源拉模型）
mineru-api --host 127.0.0.1 --port 8000 --source modelscope
```

- 只监听回环地址，与项目安全边界一致；
- 注意：官方 Docker 镜像仅支持 Linux/WSL2，**原生 Windows 走 pip 安装**，不要用 Docker；
- 模型首次下载数 GB，需一次性网络准备；
- 建议页数护栏（如 ≤ 50 页）配合超时使用，防止超大 PDF 长期占用。

README 第八节（从空环境启动）补充 MinerU 安装为「可选步骤」。

## 十一、测试策略

- **单元测试**（不碰数据库、不碰 Python）：
  - `extract/local-extraction.test.ts`：用 fixture 的 .docx（程序生成的极小文档）验证 mammoth 提取；
  - `extract/quality-gate.test.ts`：空文本/乱码/低密度各用例；
  - `FakeExtractionProvider` 加入 `src/test/fixtures.ts`，返回预设文本，供服务层测试。
- **集成测试**：upload 路由用 Fake Provider（注入方式同 FakeEmbeddingProvider），
  覆盖 multipart 解析、大小限制、各错误合同分支；真实 MinerU 不进集成测试。
- **E2E**：Playwright `setInputFiles` 上传 fixture PDF/DOCX 走完整链路（仍走 Fake API :4100）。
- 全部测试不依赖 Python 环境，CI/新机器上稳定可跑。

## 十二、评测与量化（简历数据来源）

利用现有 `eval:retrieval` harness 做解析层对比：

1. 取 1–2 篇含表格/公式的中文合成文档（或公开论文），分别制备：
   - A 组：直接 `file.text()` 提取（模拟现状的纯文本提取质量）；
   - B 组：经 MinerU 解析后入库；
2. 同一批 evaluation cases 跑检索评测，对比命中率；
3. 结果写入 `reports/retrieval/`（已 gitignore），摘一段结论进 README（如
   「解析层接入 MinerU 后，表格类查询检索命中率从 X% 提升至 Y%」）。

报告不含文档全文与模型响应，符合现有评测规范。

## 十三、实施顺序

| 阶段 | 内容 | 依赖 Python？ |
|---|---|---|
| A：地基 | 类型扩展 + 迁移 002 + `DocumentExtractionProvider` 接口 + LocalExtractionProvider（md/txt/docx）+ 质量门控 + upload 路由 + Web 变更 + 全套测试 | 否 |
| B：接入 | MinerUExtractionProvider + 配置 + 错误合同 + 部署文档 + E2E PDF 用例 | 是（运行验证需要） |
| C：量化 | 评测对比 + 报告 + README/CLAUDE.md/产品合同同步更新 | 是 |

阶段 A 完成后，系统**在没有 Python 的环境下**即可支持 .docx；阶段 B 补上 PDF 能力。
每阶段独立可交付、可测试、可回滚（迁移 002 与类型扩展在阶段 A 一并落地，B 不再动库）。

## 十四、风险与备选

| 风险 | 应对 |
|---|---|
| MinerU CPU 解析慢（扫描件单页数十秒） | 页数护栏 + 5 分钟超时 + 明确的 504 文案；不做异步队列（个人工具复杂度不值） |
| Windows 下 MinerU 有已知偶发问题 | pip 原生安装路线（非 Docker/WSL2）；问题时降级提示用户转 .txt/.md 录入 |
| 模型下载需数 GB 网络 | 文档写明 modelscope 镜像；一次性成本 |
| 引入 Python 运行时依赖 | 仅侧车可选依赖；阶段 A 不依赖 Python；README 明确标注 |
| MinerU 版本升级破坏接口 | 只依赖稳定的 `/file_parse` 与 `/health` 两个端点；文档锁定验证过的版本 |
