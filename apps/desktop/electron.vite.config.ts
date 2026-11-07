import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const here = import.meta.dirname;
const WORKSPACE = ['@commandos/contracts', '@commandos/runtime', '@commandos/tools', '@commandos/providers'];

/** Content Security Policy: strict in production; dev allows the Vite client and HMR socket. */
function csp(): Plugin {
  const prod =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const dev =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  let isBuild = false;
  return {
    name: 'commandos-csp',
    configResolved(c) {
      isBuild = c.command === 'build';
    },
    transformIndexHtml(html) {
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${isBuild ? prod : dev}" />`);
    },
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: WORKSPACE },
      rollupOptions: {
        input: {
          index: resolve(here, 'src/main/index.ts'),
          runtime: resolve(here, 'src/runtime/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // sandboxed preload scripts must be a single self-contained CommonJS file
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(here, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(here, 'src/renderer/index.html') } },
    },
    plugins: [react(), tailwindcss(), csp()],
  },
});
