import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App.tsx';
import { createApiClient, resolveApiBaseUrl } from './api/client.ts';

const api = createApiClient(resolveApiBaseUrl(import.meta.env));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
