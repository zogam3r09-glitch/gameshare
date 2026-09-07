import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createLogger, errorMessage } from '@game-share/shared';
import { App } from './App.js';
import './styles.css';

const log = createLogger('renderer');

window.addEventListener('error', (e) => log.error('erro nao tratado', { message: e.message }));
window.addEventListener('unhandledrejection', (e) =>
  log.error('promise rejeitada', { message: errorMessage(e.reason) }),
);

const root = document.getElementById('root');
if (!root) throw new Error('#root nao encontrado');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
