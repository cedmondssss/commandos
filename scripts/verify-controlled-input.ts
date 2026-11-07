/** Live native-input check on a disposable local page. Never operates a GitHub repository. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultSettings } from '@commandos/contracts';
import { browserReadPage, HelperClient, uiFind, uiPress, uiSetValue, type ToolContext } from '@commandos/tools';
import { pollUntil } from '../packages/tools/src/poll';

const expected = 'owner/fixture';
let state = { value: '', enabled: false, submissions: 0 };
const server = createServer(async (request, response) => {
  if (request.url === '/state') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state)); return; }
  if (request.url === '/events' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    state = JSON.parse(body); response.end('ok'); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>CommandOS controlled-input fixture</title><style>body{font:20px system-ui;padding:60px}input,button{display:block;margin:20px 0;font-size:20px;padding:12px}</style><h1>Disposable input verification</h1><form><label for="confirmation">Type owner/fixture to confirm</label><input id="confirmation" autocomplete="off"><button disabled>Delete fixture repository</button></form><p id="status">No submission performed</p><script>
    const input = document.querySelector('input'), button = document.querySelector('button');
    let value = '', submissions = 0;
    const report = () => fetch('/events', {method:'POST',body:JSON.stringify({value,enabled:!button.disabled,submissions})});
    input.addEventListener('input', () => { value = input.value; button.disabled = value !== 'owner/fixture'; report(); });
    document.querySelector('form').addEventListener('submit', event => {event.preventDefault();submissions++;report();});
    setInterval(() => {if(input.value !== value) input.value = value;}, 30);
  </script>`);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/controlled-input`;
const helper = new HelperClient(resolve('apps/desktop/resources/bin/CommandOSHelper'));
const signal = AbortSignal.timeout(30_000);
const journal: unknown[] = [];
const ctx: ToolContext = { runId: 'local_input_fixture', taskId: 'input', signal, dryRun: false, settings: defaultSettings(), helper, models: null, providers: { get: async () => { throw new Error('No cloud provider in local fixture'); } }, journal: { record: async (operation) => { journal.push(operation); } }, artifactsDir: '/tmp', progress: () => {}, log: () => {} };
try {
  await helper.call('workspace.open', { url, bundleId: 'com.google.Chrome' }, { signal });
  await browserReadPage.run(browserReadPage.args.parse({ browser: 'Google Chrome', expectedUrl: url, scrollPages: 0 }), ctx);
  const button = (await uiFind.run({ bundleId: 'com.google.Chrome', target: { role: 'AXButton', text: 'Delete fixture repository' }, maxResults: 5 }, ctx)).elements[0];
  if (!button || button.enabled !== false) throw new Error('Fixture button was not found disabled');
  let toolBlocked = false, nativeBlocked = false;
  try { await uiPress.run({ bundleId: 'com.google.Chrome', target: { ref: button.ref }, expectLabel: 'Delete fixture repository' }, ctx); }
  catch (error) { toolBlocked = (error as { code?: string }).code === 'disabled_element'; }
  try { await helper.call('ax.press', { ref: button.ref }, { signal }); }
  catch (error) { nativeBlocked = (error as { code?: string }).code === 'disabled_element'; }
  const field = (await uiFind.run({ bundleId: 'com.google.Chrome', target: { role: 'AXTextField', text: 'Type owner/fixture' }, maxResults: 5 }, ctx)).elements[0];
  if (!field) throw new Error('Fixture confirmation field was not found');
  const args = { bundleId: 'com.google.Chrome', target: { ref: field.ref }, value: expected };
  const output = await uiSetValue.run(args, ctx);
  const checks = await uiSetValue.verify!(args, output, ctx);
  const observed = await pollUntil(async () => {
    const response = await fetch(new URL('/state', url));
    const actual = await response.json() as typeof state;
    return actual.value === expected && actual.enabled ? actual : null;
  }, 2000, signal, 100, false);
  const finalButton = (await uiFind.run({ bundleId: 'com.google.Chrome', target: { role: 'AXButton', text: 'Delete fixture repository' }, maxResults: 5 }, ctx)).elements[0];
  const passed = toolBlocked && nativeBlocked && checks.every((check) => check.ok) && observed?.enabled === true && observed.submissions === 0 && finalButton?.enabled === true;
  const report = { checkedAt: new Date().toISOString(), method: 'Production tools and release Swift helper on a disposable controlled-input page in the real signed-in Chrome. No GitHub action or final submit is performed.', disabledToolPressBlocked: toolBlocked, disabledNativePressBlocked: nativeBlocked, inputVia: output.via, fieldReadBack: output.readBack, pageInputState: observed, finalControlEnabled: finalButton?.enabled, verification: checks, journalOperations: journal.length, passed };
  await writeFile('verification/controlled-input-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  // Close only the exact disposable localhost tab opened above, wherever it is now.
  await helper.call('osa.run', { source: `tell application id "com.google.Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nif URL of t is "${url}" then close t\nend repeat\nend repeat\nend tell` }).catch(() => {});
  helper.stop();
  await new Promise<void>((done) => server.close(() => done()));
}
