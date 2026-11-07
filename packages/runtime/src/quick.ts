import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Everyday commands that need no model at all: open an app, a site, a folder, a web search, or a
 * plainly worded email, chained with "and"/"then". Anything this parser does not fully understand
 * returns null and goes to the router as before, so it can only make commands faster.
 */
export type QuickStep =
  | { kind: 'open_app'; name: string; bundleId: string }
  | { kind: 'open_url'; label: string; url: string; bundleId: string | null }
  | { kind: 'open_folder'; label: string; path: string }
  | { kind: 'take_photo' }
  /** opens the photo taken earlier in the same command */
  | { kind: 'open_photo'; bundleId: string | null }
  | { kind: 'email'; to: string; subject: string; body: string; attachPhoto?: boolean };

const CHROME = 'com.google.Chrome';
const SAFARI = 'com.apple.Safari';

const KNOWN_APPS: Record<string, string> = {
  'google chrome': CHROME,
  chrome: CHROME,
  safari: SAFARI,
  notes: 'com.apple.Notes',
  'photo booth': 'com.apple.PhotoBooth',
  photobooth: 'com.apple.PhotoBooth',
  mail: 'com.apple.mail',
  calendar: 'com.apple.iCal',
  messages: 'com.apple.MobileSMS',
  music: 'com.apple.Music',
  photos: 'com.apple.Photos',
  maps: 'com.apple.Maps',
  reminders: 'com.apple.reminders',
  facetime: 'com.apple.FaceTime',
  calculator: 'com.apple.calculator',
  finder: 'com.apple.finder',
  'system settings': 'com.apple.systempreferences',
  settings: 'com.apple.systempreferences',
  terminal: 'com.apple.Terminal',
  textedit: 'com.apple.TextEdit',
  preview: 'com.apple.Preview',
  'app store': 'com.apple.AppStore',
  spotify: 'com.spotify.client',
  slack: 'com.tinyspeck.slackmacgap',
  zoom: 'us.zoom.xos',
  discord: 'com.hnc.Discord',
  'visual studio code': 'com.microsoft.VSCode',
  'vs code': 'com.microsoft.VSCode',
  vscode: 'com.microsoft.VSCode',
  xcode: 'com.apple.dt.Xcode',
};

const SITES: Record<string, string> = {
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
  'google mail': 'https://mail.google.com/mail/u/0/#inbox',
  'my email': 'https://mail.google.com/mail/u/0/#inbox',
  'my inbox': 'https://mail.google.com/mail/u/0/#inbox',
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  'google calendar': 'https://calendar.google.com',
  'google drive': 'https://drive.google.com',
  'google docs': 'https://docs.google.com',
  'google sheets': 'https://sheets.google.com',
  'google maps': 'https://maps.google.com',
  github: 'https://github.com',
  chatgpt: 'https://chatgpt.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  amazon: 'https://www.amazon.com',
  netflix: 'https://www.netflix.com',
  twitter: 'https://x.com',
  outlook: 'https://outlook.live.com',
  luma: 'https://lu.ma/home',
};

const FOLDERS: Record<string, string> = {
  desktop: '~/Desktop',
  downloads: '~/Downloads',
  documents: '~/Documents',
  pictures: '~/Pictures',
};

let installed: Map<string, string> | null = null;

/** App names installed on this Mac → .app path (scanned once; read-only). */
function installedApps(): Map<string, string> {
  if (installed) return installed;
  installed = new Map();
  for (const dir of ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.app')) installed.set(entry.slice(0, -4).toLowerCase(), join(dir, entry));
    }
  }
  return installed;
}

/** Bundle id for an app the user named: known names first, then installed apps by exact name. */
export function resolveApp(name: string): { name: string; bundleId: string } | null {
  const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const known = KNOWN_APPS[key];
  if (known) return { name, bundleId: known };
  const path = installedApps().get(key);
  if (!path) return null;
  try {
    const bundleId = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 2000 }).trim();
    return /^[\w.-]+$/.test(bundleId) ? { name, bundleId } : null;
  } catch {
    return null;
  }
}

const OPEN = /^(?:please\s+)?(?:open|launch|start|bring up|pull up|go to|show me|show)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+app(?:lication)?)?(?:\s+(?:in|on|with|using)\s+(?:google\s+)?(?:chrome|safari))?$/i;
const SEARCH = /^(?:search|google|look up)\s+(?:on\s+)?(?:google\s+|the web\s+|online\s+)?(?:for\s+)?(.+)$/i;
const EMAIL_START = /^(?:please\s+)?(?:send\s+(?:an?\s+)?e-?mail|e-?mail|send\s+(?:me|myself|my ?self)\s+an?\s+e-?mail)\b/i;
const EMAIL_TO = /^(?:please\s+)?(?:send\s+)?(?:an?\s+)?e-?mail\s+(?:to\s+)?(me|myself|my ?self|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)\b\s*(?:saying\b|that says\b|with the message\b|with\b|:|,|-)?\s*(.*)$/i;
const SEND_ME = /^(?:please\s+)?send\s+(me|myself|my ?self|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s+an?\s+e-?mail\b\s*(?:saying|that says|with the message|:|,|-)?\s*(.*)$/i;
/** speech filler means the wording needs the router model to tell message from noise */
const FILLER = /\b(like|whatever|wtv|um+|uh+|you know|i guess|or something)\b/i;
/** instructions about sending that trail the message ("hi and make sure it sends") */
const SEND_TAIL = /\s*,?\s*(?:and|then|&)?\s*(?:make sure (?:that )?(?:it|the (?:e-?mail|message)) (?:gets? |is )?(?:sent|sends?|goes(?: out)?)|send it(?: now| right away)?|hit send|press send|and send)\s*[.!]*$/i;
/** other instructions inside the message: let the router read the command */
const META = /\b(make sure|don'?t|do not|without|instead|subject (?:line )?is|cc|bcc|attach\w*)\b/i;

function emailStep(clause: string): QuickStep | null {
  const m = EMAIL_TO.exec(clause) ?? SEND_ME.exec(clause);
  if (!m) return null;
  const to = /^(me|myself|my ?self)$/i.test(m[1] ?? '') ? 'me' : (m[1] as string);
  const message = (m[2] ?? '').trim().replace(SEND_TAIL, '').replace(/^["“']|["”']$/g, '').trim();
  if (!message || message.length > 500 || FILLER.test(message) || META.test(message)) return null;
  const firstSentence = message.split(/(?<=[.!?])\s/)[0] ?? message;
  return { kind: 'email', to, subject: firstSentence.length <= 78 ? firstSentence : `${firstSentence.slice(0, 75)}…`, body: message };
}

function openStep(clause: string, browser: string | null): QuickStep | null {
  const search = SEARCH.exec(clause);
  if (search?.[1] && !/^(my|the)\s/i.test(search[1])) {
    const q = search[1].trim();
    return { kind: 'open_url', label: `Google search for “${q}”`, url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, bundleId: browser };
  }
  const m = OPEN.exec(clause);
  const target = m?.[1]?.trim().replace(/\s+folder$/i, '');
  if (!target) return null;
  const key = target.toLowerCase();
  const site = SITES[key];
  if (site) return { kind: 'open_url', label: target, url: site, bundleId: browser };
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(target)) return { kind: 'open_url', label: target, url: `https://${target}`, bundleId: browser };
  const folder = FOLDERS[key];
  if (folder) return { kind: 'open_folder', label: target, path: folder };
  const app = resolveApp(target);
  return app ? { kind: 'open_app', name: app.name, bundleId: app.bundleId } : null;
}

const VOCABULARY = ['send', 'email', 'myself', 'photo', 'picture', 'selfie', 'open', 'take', 'chrome', 'gmail', 'google', 'booth', 'search', 'launch', 'start', 'downloads', 'documents', 'desktop', 'pictures'];

/** Fixes typed words with two adjacent letters swapped ("sned" → "send", "myslef" → "myself"). */
export function fixSwappedLetters(text: string): string {
  return text.replace(/[A-Za-z]{4,}/g, (word) => {
    const lower = word.toLowerCase();
    if (VOCABULARY.includes(lower)) return word;
    for (let i = 0; i < lower.length - 1; i++) {
      const swapped = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
      if (VOCABULARY.includes(swapped)) return swapped;
    }
    return word;
  });
}

const TAKE_PHOTO = /^(?:please\s+)?(?:take|snap|grab)\s+(?:a\s+|an?other\s+)?(?:photo|picture|pic|selfie)(?:\s+of\s+(?:me|myself))?$/i;
const OPEN_PHOTO = /^(?:open|show)\s+(?:me\s+)?(?:the|that|my)?\s*(?:photo|picture|pic|selfie|it)(?:\s+(?:in|with|on)\s+(?:google\s+)?(chrome|safari|preview))?$/i;
const SEND_PHOTO = /^(?:send|email|mail)\s+(?:it|the photo|the picture|that|this)\s+to\s+(me|myself|my ?self|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)$|^(?:send|email|mail)\s+me\s+(?:the|that)\s+(?:photo|picture|pic)$/i;
// An empty email request after taking a photo refers to that photo. Extra text
// and constraints still go to the planner instead of being silently omitted.
const EMAIL_PHOTO = /^(?:send\s+(?:an?\s+)?e-?mail\s+to|e-?mail)\s+(me|myself|my ?self|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)$/i;

function photoStep(clause: string, steps: QuickStep[]): QuickStep | null {
  if (TAKE_PHOTO.test(clause)) return { kind: 'take_photo' };
  const tookPhoto = steps.some((s) => s.kind === 'take_photo');
  if (!tookPhoto) return null;
  const open = OPEN_PHOTO.exec(clause);
  if (open) {
    const app = (open[1] ?? '').toLowerCase();
    return { kind: 'open_photo', bundleId: app === 'chrome' ? CHROME : app === 'safari' ? SAFARI : app === 'preview' ? 'com.apple.Preview' : null };
  }
  const send = SEND_PHOTO.exec(clause) ?? EMAIL_PHOTO.exec(clause);
  if (send) {
    const to = !send[1] || /^(me|myself|my ?self)$/i.test(send[1]) ? 'me' : send[1];
    return { kind: 'email', to, subject: 'Photo', body: '', attachPhoto: true };
  }
  return null;
}

/** All clauses must be understood, else null (the router handles the command). */
export function matchQuickCommand(input: string): QuickStep[] | null {
  const text = fixSwappedLetters(input);
  const browser = /\b(?:google\s+)?chrome\b/i.test(text) ? CHROME : /\bsafari\b/i.test(text) ? SAFARI : null;
  let rest = text.trim().replace(/[.!?]+$/, '');
  const steps: QuickStep[] = [];
  while (rest) {
    const photoEmail = photoStep(rest, steps);
    if (photoEmail?.kind === 'email') {
      steps.push(photoEmail);
      break;
    }
    // an email takes the rest of the command as its message ("email me bread and milk")
    if (EMAIL_START.test(rest)) {
      const step = emailStep(rest);
      if (!step) return null;
      steps.push(step);
      break;
    }
    const m = /^(.*?)(?:\s*,\s*(?:(?:and then|then|and)\s+)?|\s+(?:and then|then|and)\s+)(.+)$/i.exec(rest);
    const clause = (m ? m[1] : rest)?.trim() ?? '';
    rest = m ? (m[2] ?? '').trim() : '';
    const step = photoStep(clause, steps) ?? openStep(clause, browser);
    if (!step) return null;
    steps.push(step);
  }
  if (!steps.length || steps.length > 6) return null;
  // the email step opens Chrome and Gmail itself: separately launching Chrome (a blank start tab)
  // or opening Gmail's inbox right before it would only add tabs
  return steps.filter((step, i) => {
    const emailLater = steps.slice(i + 1).some((s) => s.kind === 'email');
    if (!emailLater) return true;
    if (step.kind === 'open_app' && step.bundleId === CHROME) return false;
    if (step.kind === 'open_url' && step.url.startsWith('https://mail.google.com/')) return false;
    return true;
  });
}
