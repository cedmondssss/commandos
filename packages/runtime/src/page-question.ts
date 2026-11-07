/** Read-only page questions have fixed steps; planning how to inspect a browser adds no value. */
export interface PageQuestion {
  browser: 'Google Chrome' | 'Microsoft Edge' | 'Brave' | 'Arc';
  url: string | null;
  question: string;
  scrollPages: number;
}

const SITES: Record<string, string> = {
  luma: 'https://luma.com/home',
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
};
const MUTATION =
  /\b(send\w*|email|reply|forward|delet\w*|remov\w*|creat\w*|writ\w*|edit\w*|chang\w*|updat\w*|fill|submit|pay|buy|purchase|checkout|transfer|publish|post|book|register|rsvp|join|cancel|unsubscribe|download|upload|save|invite|schedule|add|click|press|sign|log|attach|export|take|snap|move|rename|quit|launch|uninstall|install|run|execute|print)\b/i;
const QUESTION = /^(?:tell me|show me|list|summari[sz]e|read|count|figure out|find out|check|what\b|how\b|which\b|when\b)/i;

export function matchPageQuestion(input: string): PageQuestion | null {
  let text = input
    .trim()
    .replace(/^(?:please|can you|could you)\s+/i, '')
    .replace(/[.!?]+$/, '');
  let browser: PageQuestion['browser'] = 'Google Chrome';
  const namedBrowser = /\s+(?:in|using|with)\s+(?:my\s+)?(google chrome|chrome|microsoft edge|edge|brave|arc)$/i.exec(text);
  if (namedBrowser) {
    const browsers: Record<string, PageQuestion['browser']> = {
      chrome: 'Google Chrome',
      'google chrome': 'Google Chrome',
      edge: 'Microsoft Edge',
      'microsoft edge': 'Microsoft Edge',
      brave: 'Brave',
      arc: 'Arc',
    };
    browser = browsers[(namedBrowser[1] as string).toLowerCase()] as PageQuestion['browser'];
    text = text.slice(0, namedBrowser.index).trim();
  }
  let url: string | null = null;
  let question = text;
  const open = /^(?:open|go to)\s+(luma|gmail|https?:\/\/\S+?)\s+(?:and then|and|then)\s+(.+)$/i.exec(text);
  if (open) {
    const site = open[1] as string;
    url = SITES[site.toLowerCase()] ?? site;
    question = open[2] as string;
  } else {
    const site = /\s+(?:on|from|in)\s+(luma|gmail)$/i.exec(text);
    if (site) {
      url = SITES[(site[1] as string).toLowerCase()] as string;
      question = text.slice(0, site.index);
    } else if (!/\b(?:this|current|the open|the current)\s+(?:web\s*)?(?:page|tab)\b/i.test(text)) return null;
  }
  if (!QUESTION.test(question) || MUTATION.test(question) || /\b(?:instead|otherwise|except|unless)\b/i.test(question)) return null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      url = parsed.href;
    } catch {
      return null;
    }
  }
  return { browser, url, question, scrollPages: /\b(all|every|count|how many|events|hackathons?)\b/i.test(question) ? 10 : 0 };
}
