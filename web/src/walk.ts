import * as T from 'three';
import { fetchAsset } from './lifetime';

type NavMeta = {
  x0: number; y0: number; cell: number; w: number; h: number;
  maskBytes: number; hStep: number; hw: number; hh: number; hCell: number;
};

export const EYE = 1.62;

/** Walkability and ground height, both baked in Blender so the browser and
 *  the model can never disagree about where a sofa is. Blender coordinates
 *  throughout: world (x, y, z) is Blender (x, -z). */
export class NavGrid {
  private mask!: Uint8Array;
  private heights!: Float32Array;
  private meta!: NavMeta;

  static async load(signal?: AbortSignal): Promise<NavGrid> {
    const g = new NavGrid();
    const [meta, buf] = await Promise.all([
      fetchAsset('model/nav.json', signal).then((r) => r.json() as Promise<NavMeta>),
      fetchAsset('model/nav.bin', signal).then((r) => r.arrayBuffer()),
    ]);
    if (![meta.x0, meta.y0, meta.cell, meta.hCell].every(Number.isFinite) ||
        meta.cell <= 0 || meta.hCell <= 0 || ![meta.w, meta.h, meta.hw, meta.hh, meta.maskBytes].every(Number.isInteger) ||
        meta.w < 2 || meta.h < 2 || meta.hw < 2 || meta.hh < 2 || meta.maskBytes % 4 ||
        meta.maskBytes < Math.ceil(meta.w * meta.h / 8) || meta.maskBytes + meta.hw * meta.hh * 4 !== buf.byteLength) throw new Error('Invalid navigation data');
    g.meta = meta;
    g.mask = new Uint8Array(buf, 0, meta.maskBytes);
    g.heights = new Float32Array(buf, meta.maskBytes, meta.hw * meta.hh);
    if (!g.heights.every(Number.isFinite)) throw new Error('Invalid ground heights');
    return g;
  }

  canStand(bx: number, by: number): boolean {
    if (!Number.isFinite(bx) || !Number.isFinite(by)) return false;
    const m = this.meta;
    const i = Math.floor((bx - m.x0) / m.cell);
    const j = Math.floor((by - m.y0) / m.cell);
    if (i < 0 || j < 0 || i >= m.w || j >= m.h) return false;
    const n = j * m.w + i;
    return (this.mask[n >> 3] & (1 << (n & 7))) !== 0;
  }

  groundAt(bx: number, by: number): number {
    const m = this.meta;
    const fx = (bx - m.x0) / m.hCell;
    const fy = (by - m.y0) / m.hCell;
    const i = Math.min(Math.max(Math.floor(fx), 0), m.hw - 2);
    const j = Math.min(Math.max(Math.floor(fy), 0), m.hh - 2);
    const tx = Math.min(Math.max(fx - i, 0), 1);
    const ty = Math.min(Math.max(fy - j, 0), 1);
    const h = this.heights;
    const a = h[j * m.hw + i], b = h[j * m.hw + i + 1];
    const c = h[(j + 1) * m.hw + i], d = h[(j + 1) * m.hw + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** Move with sliding: each axis is tried on its own, in small steps, so a
   *  wall redirects you along itself instead of stopping you dead. */
  move(bx: number, by: number, dx: number, dy: number, out: [number, number] = [0, 0]): [number, number] {
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / 0.05));
    const sx = dx / steps;
    const sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      if (this.canStand(bx + sx, by)) bx += sx;
      if (this.canStand(bx, by + sy)) by += sy;
    }
    out[0] = bx; out[1] = by;
    return out;
  }

  /** Nearest standable point, used when a walk begins somewhere marginal. */
  snap(bx: number, by: number, radius = 1.2): [number, number] | null {
    if (this.canStand(bx, by)) return [bx, by];
    const step = this.meta.cell;
    for (let r = step; r <= radius; r += step) {
      for (let a = 0; a < 16; a++) {
        const t = (a / 16) * Math.PI * 2;
        const px = bx + Math.cos(t) * r;
        const py = by + Math.sin(t) * r;
        if (this.canStand(px, py)) return [px, py];
      }
    }
    return null;
  }
}

/** The walking visitor. Deliberately close to the reference project's feel:
 *  1.62 m eye height, no jumping, a barely-there step bob, and momentum that
 *  settles in about a fifth of a second. */
export class Walker {
  bx = 2.4;
  by = 2.4;
  yaw = 0;
  pitch = 0;
  private vel = new T.Vector2();
  private bob = 0;
  private moved: [number, number] = [0, 0];
  private keys = new Set<string>();
  stick = new T.Vector2();
  boost = false;
  height = EYE;

  constructor(private nav: NavGrid, private reduced: boolean) {}

  setKey(code: string, down: boolean) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  clear() {
    this.keys.clear();
    this.stick.set(0, 0);
    this.vel.set(0, 0);
  }

  look(dx: number, dy: number, sensitivity = 0.0021) {
    this.yaw = T.MathUtils.euclideanModulo(this.yaw - dx * sensitivity + Math.PI, Math.PI * 2) - Math.PI;
    this.pitch = T.MathUtils.clamp(this.pitch - dy * sensitivity, -1.05, 1.0);
  }

  placeAt(bx: number, by: number, yaw: number, pitch: number) {
    const snapped = this.nav.snap(bx, by, 2.0);
    if (snapped) {
      this.bx = snapped[0];
      this.by = snapped[1];
    }
    this.yaw = yaw;
    this.pitch = T.MathUtils.clamp(pitch, -1.05, 1);
    this.clear();
    this.bob = 0;
    this.height = EYE;
  }

  get moving() {
    return this.vel.lengthSq() > 0.02;
  }

  update(dt: number) {
    const k = this.keys;
    let ax = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let az = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    ax += this.stick.x;
    az += this.stick.y;
    const len = Math.hypot(ax, az);
    if (len > 1) { ax /= len; az /= len; }

    const speed = (this.boost || k.has('ShiftLeft') || k.has('ShiftRight')) ? 2.15 : 1.28;
    const smooth = this.reduced ? 1 : 1 - Math.exp(-13 * dt);
    this.vel.x = T.MathUtils.lerp(this.vel.x, ax * speed, smooth);
    this.vel.y = T.MathUtils.lerp(this.vel.y, az * speed, smooth);

    // The walker's yaw is measured in the three.js frame; translate the desired
    // motion into the Blender XY the grid is stored in.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wx = (this.vel.x * cos + this.vel.y * sin) * dt;
    const wz = (-this.vel.x * sin + this.vel.y * cos) * dt;
    const beforeX = this.bx, beforeY = this.by;
    [this.bx, this.by] = this.nav.move(this.bx, this.by, wx, -wz, this.moved);

    // Walking into a wall is not a step, so the bob follows real travel.
    const travelled = Math.hypot(this.bx - beforeX, this.by - beforeY);
    const pace = dt > 0 ? travelled / dt : 0;
    this.bob += pace * dt * 6.2;
    const rise = this.reduced ? 0 : Math.sin(this.bob) * Math.min(pace / 1.3, 1) * 0.016;
    this.height = EYE + rise;
  }

  eye(out: T.Vector3) {
    return out.set(this.bx, this.nav.groundAt(this.bx, this.by) + this.height, -this.by);
  }
}
