import { createRoot } from 'react-dom/client';

import { App } from '@mcp-gateway/mainview/App';
import { client } from '@mcp-gateway/mainview/client';

import './styles/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(<App client={client} />);
