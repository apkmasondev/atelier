/** One owner for listeners and delayed UI work, including interrupted startup. */
export class Lifetime {
  readonly abort = new AbortController();
  private timers = new Set<number>();
  get signal() { return this.abort.signal; }
  later(fn: () => void, ms: number) {
    if (this.signal.aborted) return 0;
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.signal.aborted) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }
  cancel(id: number) {
    clearTimeout(id);
    this.timers.delete(id);
  }
  dispose() {
    this.abort.abort();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }
}

export async function fetchAsset(path: string, signal?: AbortSignal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}
