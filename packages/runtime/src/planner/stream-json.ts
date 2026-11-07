/**
 * Incremental extractor for the elements of a top-level array property in a JSON object that is
 * still streaming in, e.g. `{"tasks":[{…},{…}` → yields each `{…}` as soon as its closing brace
 * arrives. String contents and escapes are tracked so braces inside strings are ignored.
 */
export class StreamingArrayElements {
  private text = '';
  private i = 0;
  private depth = 0;
  private inString = false;
  private escape = false;
  private stringStart = -1;
  private lastString = '';
  private pendingKey: string | null = null;
  private arrayDepth = -1;
  private elementStart = -1;

  constructor(private readonly key: string) {}

  /** Feeds more JSON text; returns the raw text of every element completed by this chunk. */
  feed(chunk: string): string[] {
    this.text += chunk;
    const done: string[] = [];
    for (; this.i < this.text.length; this.i++) {
      const ch = this.text[this.i];
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === '\\') this.escape = true;
        else if (ch === '"') {
          this.inString = false;
          this.lastString = this.text.slice(this.stringStart + 1, this.i);
        }
        continue;
      }
      switch (ch) {
        case '"':
          this.inString = true;
          this.stringStart = this.i;
          break;
        case ':':
          if (this.depth === 1) this.pendingKey = this.lastString;
          break;
        case ',':
          if (this.depth === 1) this.pendingKey = null;
          break;
        case '{':
        case '[':
          if (ch === '[' && this.depth === 1 && this.pendingKey === this.key && this.arrayDepth === -1) this.arrayDepth = 2;
          else if (ch === '{' && this.arrayDepth > 0 && this.depth === this.arrayDepth && this.elementStart < 0) this.elementStart = this.i;
          this.depth++;
          break;
        case '}':
        case ']':
          this.depth--;
          if (ch === '}' && this.elementStart >= 0 && this.depth === this.arrayDepth) {
            done.push(this.text.slice(this.elementStart, this.i + 1));
            this.elementStart = -1;
          } else if (ch === ']' && this.arrayDepth > 0 && this.depth === this.arrayDepth - 1) {
            this.arrayDepth = -2; // array finished
          }
          break;
        default:
          break;
      }
    }
    return done;
  }
}
