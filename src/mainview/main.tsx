import { createRoot } from 'react-dom/client';

import { App } from '@mcp-gateway/mainview/App';
import { client } from '@mcp-gateway/mainview/client';
import { I18nProvider } from '@mcp-gateway/mainview/i18n';

import './styles/styles.css';

if (import.meta.env.VITE_APP_NAME) document.title = import.meta.env.VITE_APP_NAME;
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(
  <I18nProvider>
    <App client={client} />
  </I18nProvider>,
);
