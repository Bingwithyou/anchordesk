-- 扩展文档来源类型：支持 pdf 与 docx 文件上传（正文仍以 UTF-8 文本入库）。
-- 001 迁移已应用，不可修改，只能通过新迁移替换 CHECK 约束。

ALTER TABLE documents DROP CONSTRAINT documents_source_type_check;

ALTER TABLE documents ADD CONSTRAINT documents_source_type_check
  CHECK (source_type IN ('markdown', 'text', 'pdf', 'docx'));
