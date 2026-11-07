import { homedir } from 'node:os';

/**
 * Secret/PII redaction used before data leaves the process boundary that needs it:
 * telemetry export, memory writes, model prompts built from OCR/document text, and
 * sandbox staging (via containsSecret). Patterns are conservative to avoid mangling
 * ordinary text; credit-card candidates must pass a Luhn check.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(?:https?|wss?):\/\/connect\.anchorbrowser\.io\b[^\s"'<>)]*/gi, '[REDACTED_ANCHOR_CDP_URL]'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bsk-(?:proj-|svcacct-|admin-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/\bsk_[A-Za-z0-9]{24,}\b/g, '[REDACTED_API_KEY]'],
  [/\bsp-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bdtn_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bsk_live_[A-Za-z0-9]{16,}\b|\brk_live_[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g, '$1 [REDACTED]'],
  [
    /\b(password|passwd|passcode|pwd|secret|token|api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1$2[REDACTED]',
  ],
];

const SENSITIVE_KEY = /pass(word|wd|code)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|cdp[_-]?url/i;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/gi;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface RedactOptions {
  /** also mask e-mail addresses (default false) */
  emails?: boolean;
  /** replace the user's home directory with `~` (default true) */
  homePath?: boolean;
  /** truncate strings longer than this (default: no limit) */
  maxLength?: number;
}

const HOME = homedir();

export function redactText(input: string, opts: RedactOptions = {}): string {
  let s = input;
  for (const [re, replacement] of SECRET_PATTERNS) s = s.replace(re, replacement);
  s = s.replace(DATA_URL, '[REDACTED_BINARY]');
  s = s.replace(CARD_CANDIDATE, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[REDACTED_CARD]' : m;
  });
  if (opts.emails) s = s.replace(EMAIL, '[REDACTED_EMAIL]');
  if (opts.homePath !== false && HOME.length > 1) s = s.split(HOME).join('~');
  if (opts.maxLength !== undefined && s.length > opts.maxLength) s = `${s.slice(0, opts.maxLength)}…[truncated ${s.length - opts.maxLength} chars]`;
  return s;
}

/** Deep redaction for structured values. Keys that look sensitive are masked entirely. */
export function redactValue(value: unknown, opts: RedactOptions = {}, depth = 0): unknown {
  if (depth > 12) return '[REDACTED_DEPTH]';
  if (typeof value === 'string') return redactText(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, opts, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') ? '[REDACTED]' : redactValue(v, opts, depth + 1);
    }
    return out;
  }
  return value;
}

/** True when the text contains something that looks like a credential or card number. */
export function containsSecret(input: string): boolean {
  return findSecretKinds(input).length > 0;
}

/** Lists which kinds of secrets matched, for user-facing explanations (never the secret itself). */
export function findSecretKinds(input: string): string[] {
  const kinds = new Set<string>();
  for (const [re, replacement] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const hit = re.test(input);
    re.lastIndex = 0;
    if (!hit) continue;
    const label = /\[REDACTED_([A-Z_]+)\]/.exec(replacement)?.[1]?.toLowerCase() ?? 'credential_assignment';
    kinds.add(label);
  }
  for (const m of input.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) kinds.add('card_number');
  }
  return [...kinds];
}
