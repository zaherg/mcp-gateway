import { App } from '@mcp-gateway/mainview/App';
import { client } from '@mcp-gateway/mainview/client';
import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(<App client={client} />);
