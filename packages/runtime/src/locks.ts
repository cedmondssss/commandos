/**
 * Exclusive resource locks keyed by string (e.g. `fs:/Users/me/Desktop/x`, `ui:frontmost`).
 * A filesystem key also conflicts with keys for its parent or child paths.
 */
export class LockManager {
  private held = new Map<string, string>(); // key -> holder

  private conflicts(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.startsWith('fs:') && b.startsWith('fs:')) {
      const pa = a.slice(3);
      const pb = b.slice(3);
      return pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
    }
    return false;
  }

  tryAcquire(holder: string, keys: string[]): boolean {
    for (const k of keys) {
      for (const [heldKey, heldBy] of this.held) {
        if (heldBy !== holder && this.conflicts(k, heldKey)) return false;
      }
    }
    for (const k of keys) this.held.set(k, holder);
    return true;
  }

  release(holder: string): void {
    for (const [k, h] of [...this.held]) if (h === holder) this.held.delete(k);
  }

  holders(): string[] {
    return [...new Set(this.held.values())];
  }
}
