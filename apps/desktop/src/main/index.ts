import { join } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, session, shell } from 'electron';
import { createLogger, errorMessage } from '@game-share/shared';
import {
  armSource,
  disarmSource,
  isLoopbackAudioAvailable,
  isSourceArmed,
  listSources,
  markLoopbackUnavailable,
  registerDisplayMediaHandler,
} from './capture.js';

const log = createLogger('main');
const isDev = !app.isPackaged;

/** Origem exata do token-server; conhecida em build time via VITE_TOKEN_SERVER_URL. */
function tokenServerOrigin(): string {
  const raw = import.meta.env.VITE_TOKEN_SERVER_URL;
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    log.warn('VITE_TOKEN_SERVER_URL invalida; fora da CSP', { raw });
    return '';
  }
}

/**
 * TODO(v0.2): estreitar connect-src tambem para a origem exata do LiveKit. Ela
 * so e conhecida em runtime (vem na resposta do token-server), e duplicar em
 * uma var VITE_* criaria duas fontes de verdade que saem de sincronia.
 */
function contentSecurityPolicy(): string {
  const devScript = isDev ? " 'unsafe-inline' 'unsafe-eval'" : '';
  const devConnect = isDev
    ? ' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*'
    : '';
  const tokenServer = tokenServerOrigin();

  return [
    "default-src 'self'",
    `script-src 'self'${devScript}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src 'self' https: wss:${tokenServer ? ` ${tokenServer}` : ''}${devConnect}`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function applySecurityHeaders(): void {
  const csp = contentSecurityPolicy();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
  log.info('CSP aplicada', { modo: isDev ? 'dev' : 'producao', tokenServer: tokenServerOrigin() });
}

/**
 * Nada alem de captura de tela.
 *
 * O Chromium pede `media` (nao `display-capture`) para getDisplayMedia, e a
 * mesma permissao cobriria camera/microfone. Por isso `media` so passa enquanto
 * existe uma fonte armada — ou seja, na janela entre o clique do usuario em
 * INICIAR TRANSMISSAO e o getDisplayMedia resolver. Fora disso, tudo e negado.
 */
function allowPermission(permission: string): boolean {
  if (permission === 'display-capture') return true;
  if (permission === 'media') return isSourceArmed();
  return false;
}

function lockDownPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = allowPermission(permission);
    if (!allowed) log.warn('permissao negada', { permission });
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowPermission(permission));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1116',
    title: 'Game Share — POC',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // sem janelas novas e sem navegacao para fora do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    log.warn('window.open bloqueado', { url });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      log.warn('navegacao bloqueada', { url });
      event.preventDefault();
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer morreu', { reason: details.reason, exitCode: details.exitCode });
  });

  // Em dev, espelha o console do renderer no terminal. Sem isto os logs de
  // diagnostico (metricas do encoder, erros de publicacao) so existem no
  // devtools e desaparecem quando a janela fecha.
  if (isDev) {
    win.webContents.on('console-message', (_e, _level, message) => {
      log.debug(`[renderer] ${message}`);
    });
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devUrl) {
    void win.loadURL(devUrl);
    // NAO abrir o DevTools por padrao: acoplado a um renderer que esta
    // codificando video em tempo real ele custa caro e falseia qualquer
    // medicao de performance. Os logs ja vao para o terminal.
    if (process.env.GAME_SHARE_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function registerIpc(): void {
  ipcMain.handle('capture:list', () => listSources());

  ipcMain.handle('capture:select', (_e, sourceId: unknown) => {
    if (typeof sourceId !== 'string' || !/^(screen|window):/.test(sourceId)) {
      log.warn('capture:select com id invalido');
      return false;
    }
    armSource(sourceId);
    return true;
  });

  ipcMain.handle('capture:clear', () => {
    disarmSource();
  });

  ipcMain.handle('capture:audioUnavailable', () => {
    markLoopbackUnavailable();
  });

  ipcMain.handle('capture:loopbackSupported', () => isLoopbackAudioAvailable());

  ipcMain.handle('shell:copy', (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length > 2048) return false;
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('shell:openExternal', async (_e, url: unknown) => {
    if (typeof url !== 'string') return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn('openExternal bloqueado', { protocol: parsed.protocol });
      return false;
    }
    await shell.openExternal(parsed.toString());
    return true;
  });
}

/**
 * Depuracao remota em dev. A janela do Electron nao e alcancavel por
 * ferramentas de navegador, entao sem isto nao existe forma de roteirizar uma
 * transmissao — util para reproduzir um bug na mesma sequencia duas vezes.
 * Nunca em producao: abriria uma porta de controle total do renderer.
 */
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', '9222');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    applySecurityHeaders();
    lockDownPermissions();
    registerDisplayMediaHandler();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    log.info('app pronto', { versao: app.getVersion(), electron: process.versions.electron });
  });

  app.on('window-all-closed', () => {
    disarmSource();
    if (process.platform !== 'darwin') app.quit();
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaughtException no main', { message: errorMessage(err) });
  });
}
