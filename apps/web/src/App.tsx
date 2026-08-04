import { useState } from 'react';

import { DocumentsPage } from './pages/DocumentsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { QuestionPage } from './pages/QuestionPage.js';
import { ReviewQueuePage } from './pages/ReviewQueuePage.js';

type Page = 'question' | 'documents' | 'logs' | 'review';

const navigation: { page: Page; label: string }[] = [
  { page: 'question', label: '问答' },
  { page: 'documents', label: '知识文档' },
  { page: 'logs', label: '运行日志' },
  { page: 'review', label: '待处理' },
];

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('question');

  return (
    <div className="min-h-svh bg-stone-100 text-stone-900">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight">
              AnchorDesk 知识库管理
            </h1>
            <p className="mt-0.5 text-xs text-stone-500">
              本机中文管理界面：问答、文档、日志与待处理
            </p>
          </div>
          <nav aria-label="主导航" className="flex flex-wrap gap-1">
            {navigation.map(({ page, label }) => (
              <button
                key={page}
                type="button"
                aria-current={currentPage === page ? 'page' : undefined}
                onClick={() => setCurrentPage(page)}
                className={
                  currentPage === page
                    ? 'rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white focus:outline-2 focus:outline-blue-800'
                    : 'rounded-md px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-200 focus:outline-2 focus:outline-blue-700'
                }
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {currentPage === 'question' && <QuestionPage />}
        {currentPage === 'documents' && <DocumentsPage />}
        {currentPage === 'logs' && <LogsPage />}
        {currentPage === 'review' && <ReviewQueuePage />}
      </main>
    </div>
  );
}
