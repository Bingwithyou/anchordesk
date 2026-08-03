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
