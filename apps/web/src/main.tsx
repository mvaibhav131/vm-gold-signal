import '@mantine/core/styles.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { loadApiClient } from './api/client';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

const client = await loadApiClient();

createRoot(container).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
