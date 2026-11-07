/**
 * Generates realistic screenshot fixtures (real PNGs rendered by headless Chrome from HTML) and,
 * optionally, a demo folder that looks like a macOS screenshot inbox.
 *
 *   pnpm gen:fixtures                       # render PNGs into fixtures/fs/screenshots
 *   pnpm gen:fixtures --demo [--root DIR]   # also populate DIR/Screenshots (default ~/CommandOS-Demo)
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'fs', 'screenshots');
const DOCS = join(ROOT, 'fixtures', 'fs', 'docs');

const css = `
  *{box-sizing:border-box} body{margin:0;font:15px/1.45 -apple-system,"SF Pro Text",Helvetica,Arial,sans-serif;color:#1d1d1f;background:#f5f5f7}
  .win{margin:24px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.12);overflow:hidden}
  .bar{height:38px;background:#ececec;display:flex;align-items:center;padding:0 14px;gap:8px;border-bottom:1px solid #ddd}
  .dot{width:12px;height:12px;border-radius:50%} .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title{margin-left:12px;color:#555;font-size:13px} .body{padding:22px 28px} h1{font-size:22px;margin:0 0 8px} h2{font-size:17px;margin:16px 0 6px}
  table{border-collapse:collapse;width:100%} td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left} .muted{color:#6e6e73}
  pre{background:#1e1e1e;color:#d4d4d4;padding:16px;border-radius:8px;font:13px/1.5 Menlo,monospace;white-space:pre-wrap}
  .bubble{max-width:70%;padding:10px 14px;border-radius:16px;margin:8px 0} .me{background:#0a84ff;color:#fff;margin-left:auto} .them{background:#e9e9eb}
  .tot{font-weight:700;font-size:18px} .err{color:#d70015;font-weight:600}
`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="win"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">${title}</span></div><div class="body">${body}</div></div></body></html>`;

export const FIXTURES: Array<{ slug: string; html: string }> = [
  {
    slug: 'receipt-blue-bottle',
    html: page(
      'Mail — Your Blue Bottle Coffee receipt',
      `<h1>Blue Bottle Coffee — Receipt</h1><p class="muted">Order #BB-48213 · Hayes Valley, San Francisco · Oct 12, 2026 8:41 AM</p>
       <table><tr><th>Item</th><th>Qty</th><th>Price</th></tr><tr><td>New Orleans Iced Coffee</td><td>1</td><td>$6.50</td></tr>
       <tr><td>Liège Waffle</td><td>1</td><td>$5.75</td></tr><tr><td>Hayes Valley Espresso Beans 12oz</td><td>1</td><td>$22.00</td></tr></table>
       <p>Subtotal $34.25 · Tax $2.95</p><p class="tot">Total charged: $37.20 (Visa ending 4242)</p>`,
    ),
  },
  {
    slug: 'typeerror-checkout',
    html: page(
      'Terminal — npm test',
      `<pre>$ npm test

> checkout-service@2.3.1 test
> vitest run

 FAIL  src/cart/total.test.ts > applies percentage discounts
TypeError: Cannot read properties of undefined (reading 'percent')
    at applyDiscount (src/cart/total.ts:42:27)
    at computeTotal (src/cart/total.ts:18:10)

 Test Files  1 failed | 11 passed (12)
      Tests  1 failed | 86 passed (87)</pre><p class="err">1 failing test: applies percentage discounts</p>`,
    ),
  },
  {
    slug: 'chat-offsite-planning',
    html: page(
      'Messages — Team Offsite',
      `<h1>Team Offsite planning</h1>
       <div class="bubble them">Maya: Lake Tahoe cabin is confirmed for Nov 14–16 🎉</div>
       <div class="bubble me">Great! I'll book the van for 8 people.</div>
       <div class="bubble them">Jordan: Can someone handle groceries? Budget is $400.</div>
       <div class="bubble me">On it — I'll share the shopping list Thursday.</div>`,
    ),
  },
  {
    slug: 'flight-sfo-jfk',
    html: page(
      'United Airlines — Trip details',
      `<h1>Trip confirmation: San Francisco (SFO) → New York (JFK)</h1><p class="muted">Confirmation code: K7Q2ZP</p>
       <table><tr><th>Flight</th><th>Date</th><th>Departs</th><th>Arrives</th><th>Seat</th></tr>
       <tr><td>UA 1542</td><td>Thu, Oct 23, 2026</td><td>7:05 AM SFO</td><td>3:41 PM JFK</td><td>21C</td></tr>
       <tr><td>UA 1897</td><td>Sun, Oct 26, 2026</td><td>6:20 PM JFK</td><td>9:58 PM SFO</td><td>18A</td></tr></table>
       <p>Passenger: Alex Rivera · Economy Plus · 1 checked bag included</p>`,
    ),
  },
  {
    slug: 'meeting-notes-q4-roadmap',
    html: page(
      'Notes — Q4 Roadmap Sync',
      `<h1>Q4 Roadmap Sync — Oct 9</h1><p class="muted">Attendees: Priya, Sam, Lee, Alex</p>
       <h2>Decisions</h2><ul><li>Ship voice commands beta on Nov 3</li><li>Pause the Android widget until January</li></ul>
       <h2>Action items</h2><ul><li>Priya — finalize pricing page copy by Oct 17</li><li>Sam — load test the sync service (target 5k rps)</li><li>Lee — write the security review doc</li></ul>`,
    ),
  },
  {
    slug: 'recipe-shakshuka',
    html: page(
      'Safari — Easy Shakshuka',
      `<h1>Easy Shakshuka (serves 4)</h1><h2>Ingredients</h2>
       <ul><li>6 eggs</li><li>1 can (28 oz) crushed tomatoes</li><li>1 red bell pepper, diced</li><li>1 onion, diced</li><li>2 tsp cumin, 1 tsp smoked paprika</li><li>Feta and parsley to serve</li></ul>
       <h2>Steps</h2><p>Sauté onion and pepper 6 minutes, add spices and tomatoes, simmer 10 minutes, crack in eggs, cover and cook 6–8 minutes.</p>`,
    ),
  },
  {
    slug: 'analytics-signups-dashboard',
    html: page(
      'Analytics — Weekly signups',
      `<h1>Weekly signups</h1><p class="muted">Oct 6 – Oct 12, 2026</p>
       <table><tr><th>Channel</th><th>Signups</th><th>Change</th></tr><tr><td>Organic search</td><td>1,284</td><td>+12%</td></tr>
       <tr><td>Referral</td><td>642</td><td>+31%</td></tr><tr><td>Paid social</td><td>418</td><td>−8%</td></tr><tr><td>Email</td><td>205</td><td>+3%</td></tr></table>
       <p class="tot">Total signups: 2,549 (+11% week over week)</p>`,
    ),
  },
  {
    slug: 'wifi-password-settings',
    html: page(
      'System Settings — Wi-Fi',
      `<h1>Wi-Fi</h1><p>Network: <b>Rivera-Home-5G</b> · Connected · Secure (WPA3)</p>
       <p>Router: 192.168.1.1 · IP address: 192.168.1.42</p><p class="muted">Low Data Mode off · Private Wi-Fi address: Fixed</p>`,
    ),
  },
];

const INVOICE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px Helvetica,Arial,sans-serif;margin:48px}h1{font-size:24px}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}</style></head>
<body><h1>Invoice INV-2026-0142</h1><p>Northwind Design Studio · 410 Market St, San Francisco</p><p>Bill to: Rivera Labs · Due: November 13, 2026</p>
<table><tr><th>Description</th><th>Hours</th><th>Amount</th></tr><tr><td>Brand refresh — logo system</td><td>18</td><td>$2,700.00</td></tr><tr><td>Website design — 6 templates</td><td>32</td><td>$4,800.00</td></tr></table>
<p><b>Total due: $7,500.00</b></p><p>Payment terms: net 30. Late payments incur 1.5% monthly interest.</p></body></html>`;

const MEMO_HTML = `<html><body><h1>Memo: Office move</h1><p>From: Operations</p><p>The San Francisco team moves to the 5th floor on Friday, November 7. Pack desks by Thursday 4 PM. IT will reconnect monitors on Saturday.</p><p>Questions: ops@example.com</p></body></html>`;

const NOTES_MD = `# Launch checklist\n\n- [x] Freeze scope for voice beta\n- [ ] Security review sign-off (Lee)\n- [ ] Pricing page copy (Priya, due Oct 17)\n- [ ] Load test sync service to 5k rps (Sam)\n\nLaunch date: **November 3, 2026**.\n`;

/** Writes document fixtures: Markdown, PDF (headless Chrome), DOCX and RTF (macOS textutil). */
async function renderDocs(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<string[]> {
  await mkdir(DOCS, { recursive: true });
  await writeFile(join(DOCS, 'launch-checklist.md'), NOTES_MD);
  const page = await browser.newPage();
  await page.setContent(INVOICE_HTML, { waitUntil: 'load' });
  await page.pdf({ path: join(DOCS, 'invoice-INV-2026-0142.pdf'), format: 'Letter', printBackground: true });
  await page.close();
  const memoHtml = join(DOCS, 'memo.html');
  await writeFile(memoHtml, MEMO_HTML);
  execFileSync('/usr/bin/textutil', ['-convert', 'docx', '-output', join(DOCS, 'memo-office-move.docx'), memoHtml]);
  execFileSync('/usr/bin/textutil', ['-convert', 'rtf', '-output', join(DOCS, 'memo-office-move.rtf'), memoHtml]);
  await rm(memoHtml);
  return ['launch-checklist.md', 'invoice-INV-2026-0142.pdf', 'memo-office-move.docx', 'memo-office-move.rtf'].map((f) => join(DOCS, f));
}

async function render(): Promise<string[]> {
  await mkdir(OUT, { recursive: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const files: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 680 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    for (const f of FIXTURES) {
      await p.setContent(f.html, { waitUntil: 'load' });
      const file = join(OUT, `${f.slug}.png`);
      await p.screenshot({ path: file, fullPage: false });
      files.push(file);
    }
    files.push(...(await renderDocs(browser)));
  } finally {
    await browser.close();
  }
  return files;
}

/** Binary plist for boolean `true`, the value macOS writes for kMDItemIsScreenCapture. */
const BPLIST_TRUE_HEX = '62706c697374303009080000000000000101000000000000000100000000000000000000000000000009';

function screenshotName(d: Date): string {
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${h}.${pad(d.getMinutes())}.${pad(d.getSeconds())} ${ampm}.png`;
}

/** Copies the rendered PNGs into `<dir>` with macOS screenshot names and staggered times (newest first in FIXTURES order). */
export async function populateScreenshotInbox(dir: string, opts: { clean?: boolean; now?: number } = {}): Promise<string[]> {
  if (opts.clean) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const now = opts.now ?? Date.now();
  const out: string[] = [];
  for (const [i, f] of FIXTURES.entries()) {
    const when = new Date(now - (i + 1) * 47 * 60_000);
    const target = join(dir, screenshotName(when));
    await copyFile(join(OUT, `${f.slug}.png`), target);
    await utimes(target, when, when);
    try {
      execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.metadata:kMDItemIsScreenCapture', BPLIST_TRUE_HEX, target]);
    } catch {
      // Spotlight attribute is best-effort; the folder scan still finds the files
    }
    out.push(target);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const existing = await readdir(OUT).catch(() => [] as string[]);
  const docs = await readdir(DOCS).catch(() => [] as string[]);
  if (args.includes('--force') || existing.filter((f) => f.endsWith('.png')).length < FIXTURES.length || docs.length < 4) {
    const files = await render();
    console.log(`rendered ${files.length} fixtures (screenshots + documents) under fixtures/fs`);
  } else {
    console.log(`fixture screenshots already present in ${OUT} (use --force to re-render)`);
  }
  if (args.includes('--demo')) {
    const rootIdx = args.indexOf('--root');
    const root = rootIdx >= 0 && args[rootIdx + 1] ? resolve(args[rootIdx + 1] as string) : join(homedir(), 'CommandOS-Demo');
    const files = await populateScreenshotInbox(join(root, 'Screenshots'), { clean: args.includes('--clean') });
    await writeFile(join(root, 'README.txt'), 'Demo files created by CommandOS (pnpm gen:fixtures --demo). Safe to delete.\n');
    console.log(`demo inbox: ${files.length} screenshots in ${join(root, 'Screenshots')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
