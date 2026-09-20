import { expect, test } from '@playwright/test';

// 与 E2E 服务器端的 FakeEmbeddingProvider 配合：
// 相同文本得到相同哈希向量，因此“提问文本 = 文档全文”时检索距离为 0 必被命中；
// 知识库外问题的哈希向量距离远超 0.45 门槛，必然触发 low_similarity 拒答。
const DOCUMENT_TITLE = '退款政策';
const DOCUMENT_CONTENT =
  '退款政策：退款申请期限为 7 个自然日。退款审核通过后，金额将在 3 个工作日内退回原支付方式。人工支持服务时间为周一至周五 09:00—18:00。';
const OUTSIDE_QUESTION = '明天上海天气如何？';

test('完整 E2E 流程：文档、问答、反馈、拒答、待处理与日志', async ({
  page,
}) => {
  // 1. 打开文档页并确认导航状态。
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'AnchorDesk 知识库管理' }),
  ).toBeVisible();
  const documentsNav = page.getByRole('button', { name: '知识文档' });
  await documentsNav.click();
  await expect(documentsNav).toHaveAttribute('aria-current', 'page');

  // 2. 创建一篇中文文档（空列表时页头与空状态各有“新建文档”按钮，取第一个）。
  await page.getByRole('button', { name: '新建文档' }).first().click();
  await page.getByLabel('标题').fill(DOCUMENT_TITLE);
  await page.getByLabel('内容').fill(DOCUMENT_CONTENT);
  // 文件选择控件也是 button 角色且 label 含“保存”二字，必须精确匹配提交按钮。
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('文档已创建')).toBeVisible();
  const documentItem = page.getByRole('button', {
    name: new RegExp(DOCUMENT_TITLE),
  });
  await expect(documentItem).toBeVisible();
  await expect(documentItem).toContainText('1 个分块');
  await expect(documentItem).toHaveAttribute('aria-current', 'true');

  // 3. 返回问答页并提交可回答问题。
  await page.getByRole('button', { name: '问答' }).click();
  await page.getByLabel('问题').fill(DOCUMENT_CONTENT);
  await page.getByRole('button', { name: '提交问题' }).click();

  // 4. 验证中文答案与行内引用。
  await expect(
    page.getByText(/根据《退款政策》，退款申请期限为 7 个自然日/),
  ).toBeVisible();
  const citationLink = page.getByRole('link', { name: '[1]' });
  await expect(citationLink).toBeVisible();

  // 5. 行内引用定位证据卡片，验证标题、内容与距离。
  await citationLink.click();
  const evidenceCard = page.locator('#citation-1');
  await expect(evidenceCard).toBeVisible();
  await expect(evidenceCard).toContainText(DOCUMENT_TITLE);
  await expect(evidenceCard).toContainText('退款申请期限为 7 个自然日');
  await expect(evidenceCard).toContainText('距离：0.0000');

  // 6. 对该回答提交“不太有帮助”，按钮随后锁定。
  //    “有帮助”是“没有帮助”的子串，name 匹配必须精确。
  await page.getByRole('button', { name: '没有帮助', exact: true }).click();
  await expect(page.getByText(/已记录：没帮助/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: '有帮助', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '没有帮助', exact: true }),
  ).toBeDisabled();

  // 7. 提交知识库外问题，验证固定拒答且拒答卡片没有反馈按钮。
  await page.getByLabel('问题').fill(OUTSIDE_QUESTION);
  await page.getByRole('button', { name: '提交问题' }).click();
  await expect(
    page.getByText('知识库中没有足够依据回答这个问题。'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '有帮助', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '没有帮助', exact: true }),
  ).toHaveCount(0);

  // 8. 打开待处理页，两类项目均出现。
  //    徽章“用户反馈没帮助”与详情 dl 的拼接文本相同，改用 dd 的精确值“没帮助”。
  await page.getByRole('button', { name: '待处理' }).click();
  await expect(page.getByText('知识拒答')).toHaveCount(1);
  await expect(page.getByText('没帮助', { exact: true })).toHaveCount(1);

  // 9. 输入备注并标记其中一项为已解决。
  await page.getByLabel('处理备注').first().fill('已补充依据，问题已解决');
  await page.getByRole('button', { name: '标记为已解决' }).first().click();
  await expect(page.getByText('已标记为已解决')).toBeVisible();
  await expect(page.getByText('已解决', { exact: true })).toHaveCount(1);
  await expect(page.getByText('没帮助', { exact: true })).toHaveCount(1);

  // 10. 打开日志页，先看已回答日志：配置、被引用 hit 与完整 chunk 内容。
  await page.getByRole('button', { name: '运行日志' }).click();
  await expect(page.getByText('最近 100 条')).toBeVisible();
  await page.getByRole('button', { name: /反馈：没帮助/ }).click();
  const logDetail = page.locator('article');
  await expect(logDetail.getByText('日志详情')).toBeVisible();
  await expect(logDetail.getByText('证据快照（1）')).toBeVisible();
  await expect(logDetail.getByText('通过门槛')).toBeVisible();
  await expect(logDetail.getByText('被引用')).toBeVisible();
  await expect(logDetail.getByText('距离：0.0000')).toBeVisible();
  // 问题与回答正文都含相同文本，完整 chunk 内容只在 hits 快照的 ol 内断言。
  await expect(
    logDetail.locator('ol').getByText(/退款申请期限为 7 个自然日/),
  ).toBeVisible();
  await expect(logDetail.getByText('Answer 模型')).toBeVisible();
  await expect(logDetail.getByText('Embedding 模型')).toBeVisible();
  await expect(logDetail.getByText('距离门槛')).toBeVisible();

  // 11. 再看拒答日志：固定拒答原因、未生成与未过门槛的 hits。
  await page.getByRole('button', { name: /拒答/ }).click();
  await expect(logDetail.getByText('拒答：未找到相似依据')).toBeVisible();
  await expect(logDetail.getByText('未生成')).toBeVisible();
  await expect(logDetail.getByText('证据快照（1）')).toBeVisible();
  await expect(logDetail.getByText('未过门槛')).toBeVisible();
});

test('上传 docx 文件由服务端解析入库', async ({ page }) => {
  // 1. 进入文档页并新建文档。
  await page.goto('/');
  await page.getByRole('button', { name: '知识文档' }).click();
  await page.getByRole('button', { name: '新建文档' }).first().click();

  // 2. 选择 docx 文件：客户端不读文本，仅提示保存时由服务端解析。
  await page
    .locator('#document-file')
    .setInputFiles('apps/api/src/test/data/sample.docx');
  await expect(
    page.getByText(/已选择 sample\.docx，保存时将上传并由服务端解析（docx）/),
  ).toBeVisible();
  await expect(page.getByLabel('标题')).toHaveValue('sample');

  // 3. 保存触发 multipart 上传，成功后进入编辑态。
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('文档已创建')).toBeVisible();
  await expect(page.getByLabel('内容')).toHaveValue(
    '这是 Fake 提取的文档内容，用于验证上传链路。',
  );

  // 4. 列表中出现该文档，来源类型为 docx。
  const documentItem = page.getByRole('button', { name: /sample/ });
  await expect(documentItem).toBeVisible();
  await expect(documentItem).toContainText('docx');
});

test('上传 pdf 文件走 PDF 上传流程', async ({ page }) => {
  // 1. 进入文档页并新建文档。
  await page.goto('/');
  await page.getByRole('button', { name: '知识文档' }).click();
  await page.getByRole('button', { name: '新建文档' }).first().click();

  // 2. 选择 pdf 文件：提示保存时由服务端解析，标题取文件名主体。
  await page
    .locator('#document-file')
    .setInputFiles('apps/api/src/test/data/sample-pdf.pdf');
  await expect(
    page.getByText(/已选择 sample-pdf\.pdf，保存时将上传并由服务端解析（pdf）/),
  ).toBeVisible();
  await expect(page.getByLabel('标题')).toHaveValue('sample-pdf');

  // 3. 保存上传成功后进入编辑态，列表来源类型为 pdf。
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('文档已创建')).toBeVisible();
  const documentItem = page.getByRole('button', { name: /sample-pdf/ });
  await expect(documentItem).toBeVisible();
  await expect(documentItem).toContainText('pdf');
});
