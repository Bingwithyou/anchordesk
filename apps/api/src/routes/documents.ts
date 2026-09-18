import type { FastifyPluginAsync } from 'fastify';

import {
  DocumentServiceError,
  type DocumentService,
} from '../services/document-service.js';

export interface DocumentRoutesOptions {
  documentService: DocumentService;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function parseDocumentId(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new DocumentServiceError();
  }
  return value;
}

export const documentRoutes: FastifyPluginAsync<DocumentRoutesOptions> = async (
  app,
  { documentService },
) => {
  app.post('/api/documents', async (request, reply) => {
    const result = await documentService.createDocument(request.body);
    return reply.code(201).send(result);
  });

  app.post('/api/documents/upload', async (request, reply) => {
    const part = await request.file();
    if (part === undefined) {
      throw new DocumentServiceError('invalid_document');
    }
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        throw new DocumentServiceError('file_too_large');
      }
      throw error;
    }
    const titleField = part.fields.title;
    const title =
      titleField !== undefined &&
      !Array.isArray(titleField) &&
      titleField.type === 'field' &&
      typeof titleField.value === 'string'
        ? titleField.value
        : undefined;
    const result = await documentService.createDocumentFromFile({
      filename: part.filename,
      data,
      title,
    });
    return reply.code(201).send(result);
  });

  app.get('/api/documents', async () => documentService.listDocuments());

  app.delete<{ Params: { id: string } }>(
    '/api/documents/:id',
    async (request, reply) => {
      await documentService.deleteDocument(parseDocumentId(request.params.id));
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/documents/:id',
    async (request) => {
      const document = await documentService.getDocument(
        parseDocumentId(request.params.id),
      );
      if (!document) {
        throw new DocumentServiceError('document_not_found');
      }
      return document;
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/documents/:id',
    async (request) =>
      documentService.updateDocument(
        parseDocumentId(request.params.id),
        request.body,
      ),
  );
};
