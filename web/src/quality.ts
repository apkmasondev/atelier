export type Tier = 'low' | 'medium' | 'high';

export type Settings = {
  tier: Tier;
  maxDpr: number;
  shadows: boolean;
  shadowSize: number;
  ao: boolean;
  bloom: boolean;
  msaa: number;
  /** Fraction of scattered planting instances that is actually built. */
  scatter: number;
};

const PRESETS: Record<Tier, Omit<Settings, 'tier'>> = {
  high:   { maxDpr: 1.7,  shadows: true,  shadowSize: 2048, ao: true,  bloom: true,  msaa: 4, scatter: 1.0 },
  medium: { maxDpr: 1.35, shadows: true,  shadowSize: 1024, ao: true,  bloom: false, msaa: 2, scatter: 0.72 },
  low:    { maxDpr: 1.0,  shadows: false, shadowSize: 512,  ao: false, bloom: false, msaa: 0, scatter: 0.4 },
};

/** A first guess from what the browser will admit to. It is only a guess —
 *  the frame timer below is what actually decides. */
export function detectTier(gl: WebGL2RenderingContext | WebGLRenderingContext | null): Tier {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  let score = 0;
  score += cores >= 8 ? 2 : cores >= 4 ? 1 : 0;
  score += mem >= 8 ? 2 : mem >= 4 ? 1 : 0;
  score += coarse ? -2 : 1;
  score += window.innerWidth * window.innerHeight > 2_600_000 ? -1 : 0;

  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  if (/apple m\d|radeon (rx|pro)|geforce (rtx|gtx 1[0-9])|arc a/i.test(name)) score += 2;
  if (/swiftshader|llvmpipe|software|mali-4|adreno \d{2}\b/i.test(name)) score -= 4;

  // A phone that reports eight cores is still a phone: cap it, whatever the
  // score says, and let the frame timer promote nothing it cannot hold.
  if (score >= 4) return coarse ? 'medium' : 'high';
  if (score >= 1) return coarse ? 'low' : 'medium';
  return 'low';
}

export function settingsFor(tier: Tier): Settings {
  return { tier, ...PRESETS[tier] };
}

/** Two-second windows and sustained tail latency, with time-based hysteresis.
 * A single shader compile or a hidden tab must not downgrade a good device. */
export class Governor {
  private samples: number[] = [];
  private last = 0;
  private windowStart = 0;
  private cooldownUntil = 0;
  private badWindows = 0;
  private goodWindows = 0;
  fps = 0;
  p95 = 0;
  dpr: number;
  readonly floor: number;

  constructor(private settings: Settings, private onDrop: (what: 'ao' | 'bloom' | 'shadows') => void) {
    this.dpr = Math.min(devicePixelRatio || 1, settings.maxDpr);
    this.floor = Math.min(this.dpr, settings.tier === 'low' ? 0.6 : 0.75);
  }

  reset() {
    this.samples.length = 0;
    this.last = this.windowStart = 0;
    this.badWindows = this.goodWindows = 0;
  }

  tick(now: number): number | null {
    if (!this.last) { this.last = this.windowStart = now; return null; }
    const dt = now - this.last;
    this.last = now;
    if (dt <= 0 || dt > 500) { this.reset(); return null; }
    this.samples.push(dt);
    if (now - this.windowStart < 2000) return null;
    const samples = this.samples;
    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1];
    this.p95 = samples[Math.floor(samples.length * 0.95)];
    this.fps = 1000 / (samples.reduce((sum, v) => sum + v, 0) / samples.length);
    samples.length = 0;
    this.windowStart = now;
    if (now < this.cooldownUntil) return null;
    const bad = median > 20.5 || this.p95 > 27;
    const good = median < 17.5 && this.p95 < 19;
    this.badWindows = bad ? this.badWindows + 1 : 0;
    this.goodWindows = good ? this.goodWindows + 1 : 0;
    if (this.badWindows >= 2) {
      this.badWindows = this.goodWindows = 0;
      this.cooldownUntil = now + 4000;
      if (this.dpr > this.floor + 0.01) {
        this.dpr = Math.max(this.floor, Math.round((this.dpr - 0.15) * 100) / 100);
        return this.dpr;
      }
      for (const what of ['bloom', 'ao', 'shadows'] as const) {
        if (this.settings[what]) {
          this.settings[what] = false;
          this.onDrop(what);
          this.cooldownUntil = now + 8000;
          break;
        }
      }
    }
    const ceiling = Math.min(devicePixelRatio || 1, this.settings.maxDpr);
    if (this.dpr > ceiling) { this.dpr = ceiling; return this.dpr; }
    if (this.goodWindows >= 6 && this.dpr < ceiling) {
      this.goodWindows = 0;
      this.cooldownUntil = now + 8000;
      this.dpr = Math.min(ceiling, Math.round((this.dpr + 0.1) * 100) / 100);
      return this.dpr;
    }
    return null;
  }
}
