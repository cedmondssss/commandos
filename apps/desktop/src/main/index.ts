import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AudioChunkSchema,
  InvokeEnvelopeSchema,
  isMainMethod,
  isRuntimeMethod,
  MainApi,
  type MainMethod,
  type PushChannel,
  PushSchemas,
  RuntimeApi,
} from '@commandos/contracts';
import {
  app,
  BrowserWindow,
  globalShortcut,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron';
import type { z } from 'zod';
import { RuntimeHost, runtimeEntry } from './runtime-host';

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const repoRoot = resolve(here, '../../../..');
const RENDERER_DIR = join(here, '../renderer');
const APP_ORIGIN = 'app://commandos';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

app.setName('CommandOS');
app.setPath('userData', process.env.COMMANDOS_DATA_DIR ?? join(app.getPath('appData'), 'CommandOS'));

// Serve the renderer from a privileged custom scheme instead of file:// (secure context, CSP header).
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;
let barWindow: BrowserWindow | null = null;
let quitting = false;

const log = (m: string) => {
  if (isDev || process.env.COMMANDOS_LOG) console.log(m);
};

const runtime = new RuntimeHost({
  entry: runtimeEntry(here),
  env: {
    ...(process.env as Record<string, string>),
    COMMANDOS_DATA_DIR: app.getPath('userData'),
    COMMANDOS_HELPER_PATH: isDev
      ? join(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'CommandOSHelper')
      : join(process.resourcesPath, 'bin', 'CommandOSHelper'),
    COMMANDOS_VERIFICATION_REPORT: isDev ? join(repoRoot, 'verification', 'report.json') : join(app.getPath('userData'), 'verification.json'),
    ...(isDev ? { COMMANDOS_SAFETY_REPORT_FALLBACK: join(repoRoot, 'verification', 'safety-lab', 'latest.json') } : {}),
    // development credentials: .env.local, then .env (both git-ignored); Keychain still wins
    ...(isDev ? { COMMANDOS_DOTENV: ['.env.local', '.env'].map((f) => join(repoRoot, f)).filter((f) => existsSync(f)).join(',') } : {}),
    NODE_ENV: isDev ? 'development' : 'production',
  },
  onPush: (channel, payload) => broadcast(channel, payload),
  log,
});

function broadcast(channel: PushChannel, payload: unknown): void {
  const schema = PushSchemas[channel];
  if (!schema.safeParse(payload).success) {
    log(`dropped invalid ${channel} push`);
    return;
  }
  for (const w of [mainWindow, barWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('commandos:push', { channel, payload });
  }
  // a run started (voice, CLI, dashboard): bring the overlay back without stealing focus
  if (channel === 'run:event' && (payload as { type: string }).type === 'run_created' && barWindow && !barWindow.isDestroyed() && !barWindow.isVisible()) barWindow.showInactive();
}

function sendToBar(channel: PushChannel, payload: unknown): void {
  if (barWindow && !barWindow.isDestroyed()) barWindow.webContents.send('commandos:push', { channel, payload });
}

function isAppUrl(url: string): boolean {
  if (isDev && process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  return url.startsWith(`${APP_ORIGIN}/`);
}

function trustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || !isAppUrl(frame.url)) return false;
  return [mainWindow, barWindow].some((w) => w && !w.isDestroyed() && w.webContents.id === event.sender.id);
}

const webPreferences = () => ({
  preload: join(here, '../preload/index.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
  navigateOnDragDrop: false,
});

function loadView(win: BrowserWindow, view: 'main' | 'bar'): void {
  if (isDev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${view}`);
  else void win.loadURL(`${APP_ORIGIN}/index.html#/${view}`);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'CommandOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0b0c10',
    webPreferences: webPreferences(),
  });
  // the overlay is the primary surface; the dashboard opens on demand (Dashboard button, Dock)
  win.once('ready-to-show', () => {
    if (process.env.COMMANDOS_OPEN_DASHBOARD === '1') win.show();
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  loadView(win, 'main');
  return win;
}

/**
 * See-through overlay that floats above every app (top right, all Spaces, over full-screen apps):
 * the command input, live steps, approvals and the answer, while the app being driven stays
 * visible underneath. It appears without taking focus, so keystrokes CommandOS sends to another
 * app are never caught by the overlay.
 */
function createBarWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const width = 420;
  const win = new BrowserWindow({
    width,
    height: 132,
    x: Math.round(display.workArea.x + display.workArea.width - width - 16),
    y: Math.round(display.workArea.y + 16),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    hasShadow: true,
    // clear tint, no blur: the app underneath stays readable through the overlay
    backgroundColor: '#00000000',
    roundedCorners: true,
    // a non-activating panel (NSPanel): floats over full-screen apps without activating CommandOS;
    // it cannot take keyboard focus until the user types in it (see focusBar), so keystrokes that
    // CommandOS sends to other apps never land in the overlay; clicks work without focus
    type: 'panel',
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: webPreferences(),
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => win.showInactive());
  win.on('blur', () => win.setFocusable(false));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  loadView(win, 'bar');
  return win;
}

function focusBar(): void {
  if (!barWindow || barWindow.isDestroyed()) barWindow = createBarWindow();
  barWindow.setFocusable(true);
  barWindow.show();
  barWindow.focus();
}

function releaseBar(): void {
  if (!barWindow || barWindow.isDestroyed()) return;
  barWindow.setFocusable(false);
  barWindow.blur();
}

function showBar(): void {
  focusBar();
  sendToBar('ui:command', { action: 'focus-input' });
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

const SETTINGS_PANES: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

type MainReq<M extends MainMethod> = z.output<(typeof MainApi)[M]['req']>;
const mainHandlers: { [M in MainMethod]: (req: MainReq<M>) => Promise<z.input<(typeof MainApi)[M]['res']>> } = {
  'window.show': async ({ which }) => {
    if (which === 'main') showMain();
    else showBar();
    return { ok: true };
  },
  'window.hideBar': async () => {
    barWindow?.hide();
    return { ok: true };
  },
  'window.focusBar': async () => {
    focusBar();
    return { ok: true };
  },
  'window.releaseBar': async () => {
    releaseBar();
    return { ok: true };
  },
  'window.fitBar': async ({ height }) => {
    if (barWindow && !barWindow.isDestroyed()) {
      const b = barWindow.getBounds();
      const max = screen.getDisplayMatching(b).workArea.height - 32;
      barWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.min(height, max) });
    }
    return { ok: true };
  },
  'system.openSettings': async ({ pane }) => {
    await shell.openExternal(SETTINGS_PANES[pane] as string);
    return { ok: true };
  },
  'microphone.status': async () => ({ status: systemPreferences.getMediaAccessStatus('microphone') }),
  'microphone.request': async () => ({ granted: await systemPreferences.askForMediaAccess('microphone') }),
};

function registerIpc(): void {
  ipcMain.handle('commandos:invoke', async (event, envelope: unknown) => {
    if (!trustedSender(event)) throw new Error('untrusted sender');
    const { method, params } = InvokeEnvelopeSchema.parse(envelope);
    if (isMainMethod(method)) {
      const spec = MainApi[method];
      const req = spec.req.parse(params ?? {});
      const handler = mainHandlers[method] as (r: unknown) => Promise<unknown>;
      return spec.res.parse(await handler(req));
    }
    if (isRuntimeMethod(method)) {
      const spec = RuntimeApi[method];
      const req = spec.req.parse(params ?? {});
      if (method === 'emergency.stop') {
        broadcast('ui:command', { action: 'stop-voice' });
        const how = await runtime.emergencyStop();
        log(`emergency stop (${how})`);
        return { ok: true };
      }
      return spec.res.parse(await runtime.request(method, req));
    }
    throw new Error(`unknown method ${method}`);
  });

  ipcMain.on('commandos:audio', (event, chunk: unknown) => {
    if (!trustedSender(event)) return;
    const parsed = AudioChunkSchema.safeParse(chunk);
    if (parsed.success) runtime.sendAudio(parsed.data);
  });
}

function hardenSessions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const audioOnly = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio');
    callback(Boolean(audioOnly) && isAppUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isAppUrl(`${origin}/`));
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!isAppUrl(url)) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'commandos') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = normalize(join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR + sep)) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
        '.json': 'application/json',
      };
      return new Response(body, {
        headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  void net; // fetch via net is not needed: files are served from disk
}

function registerShortcuts(): void {
  const register = (accel: string, fn: () => void) => {
    if (!globalShortcut.register(accel, fn)) log(`could not register global shortcut ${accel}`);
  };
  register('Alt+Space', () => {
    if (barWindow?.isVisible() && barWindow.isFocused()) releaseBar();
    else showBar();
  });
  register('Control+Alt+Space', () => {
    showBar();
    sendToBar('ui:command', { action: 'toggle-voice' });
  });
  register('Control+Alt+Escape', () => {
    broadcast('ui:command', { action: 'stop-voice' });
    void runtime.emergencyStop().then((how) => log(`emergency stop via shortcut (${how})`));
  });
}

app.whenReady().then(async () => {
  hardenSessions();
  registerAppProtocol();
  registerIpc();
  runtime.start();
  mainWindow = createMainWindow();
  barWindow = createBarWindow();
  registerShortcuts();
  app.on('activate', () => showMain());
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (runtime.status !== 'crashed') {
    e.preventDefault();
    void runtime.stop().finally(() => {
      runtime.status = 'crashed';
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  // keep running in the background for the command bar
});
