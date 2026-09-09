/**
 * Background ambience.
 *
 * Off by default and not fetched at all until the visitor asks for it, so a
 * visit that never touches the control costs nothing. The file is already a
 * seamless loop (see scripts/build-ambience.mjs), so `loop` wraps it without
 * a click and no Web Audio graph is needed — which also keeps decoding off
 * the thread that draws.
 */
const SRC = 'media/atelier-ambience.m4a';
const LEVEL = 0.3;

export class Ambience {
  private el: HTMLAudioElement | null = null;
  private target = 0;
  private level = 0;
  on = false;
  blocked = false;
  private generation = 0;
  private disposed = false;

  /** Returns the new state, or null if the browser refused to play. */
  async toggle(): Promise<boolean | null> {
    if (this.disposed) return false;
    const generation = ++this.generation;
    if (this.on) {
      this.on = false;
      this.target = 0;
      return false;
    }
    if (!this.el) {
      const el = new Audio();
      el.src = SRC;
      el.loop = true;
      el.preload = 'auto';
      el.volume = 0;
      el.crossOrigin = 'anonymous';
      this.el = el;
    }
    this.on = true;
    try {
      await this.el.play();
    } catch {
      if (this.disposed || generation !== this.generation) return this.on;
      this.blocked = true;
      this.on = false;
      this.target = 0;
      return null;
    }
    if (this.disposed || generation !== this.generation) return this.on;
    this.blocked = false;
    this.on = true;
    this.target = LEVEL;
    return true;
  }

  private retry = 0;

  /** Ramp the level so nothing ever starts or stops abruptly. */
  update(dt: number) {
    if (!this.el) return;
    // Browsers suspend media for reasons of their own — a tab losing focus mid
    // fetch, a power policy. If the visitor asked for sound, keep asking.
    this.retry += dt;
    if (this.on && this.el.paused && !document.hidden && this.retry > 1.5) {
      this.retry = 0;
      void this.el.play().catch(() => {});
    }
    const speed = this.target > this.level ? 0.42 : 0.9;
    const step = speed * dt;
    if (Math.abs(this.target - this.level) <= step) this.level = this.target;
    else this.level += Math.sign(this.target - this.level) * step;
    this.el.volume = Math.max(0, Math.min(1, this.level));
    if (this.level === 0 && !this.on && !this.el.paused) this.el.pause();
  }

  /** Silence while the tab is in the background; pick up on return. */
  setPageVisible(visible: boolean) {
    if (!this.el) return;
    if (!visible) this.el.pause();
    else if (this.on) void this.el.play().catch(() => {});
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.on = false;
    this.target = this.level = 0;
    if (!this.el) return;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el = null;
  }
}
