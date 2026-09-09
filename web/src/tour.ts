import * as T from 'three';

/** Blender is Z-up, glTF is Y-up. Everything in this project is authored in
 *  the Blender frame, where +X walks away from the facade, +Y runs along it
 *  and Z is height, so this is the one place the two frames meet. */
export const bl = (x: number, y: number, z: number) => new T.Vector3(x, z, -y);

export type Station = {
  name: string;
  line: string;
  eye: [number, number, number];      // Blender coordinates
  aim: [number, number, number];
  fov: number;
  /** 0 = late morning, 1 = dusk. Drives the whole light rig. */
  time: number;
  /** A little camera roll, in degrees, so the frames are composed. */
  roll?: number;
  /** Exposure trim in stops-ish. Interiors sit several stops under the garden;
   *  a photographer would open up indoors, and so does the tour. */
  bias?: number;
};

/** The route runs the way you would actually show the place: in from the
 *  door, round the living room, along the window wall, out through the
 *  sliding door and down into the garden, then back to look at it lit. */
export const STATIONS: Station[] = [
  {
    name: 'Próg', line: 'wejście, i cała głębia naraz',
    eye: [0.72, 1.32, 1.62], aim: [3.85, 3.55, 1.15], fov: 46, time: 0.06, bias: 0.26,
  },
  {
    name: 'Salon', line: 'len, dąb, aksamit',
    eye: [2.62, 1.78, 1.24], aim: [1.05, 4.35, 0.82], fov: 40, time: 0.14, roll: -0.5, bias: 0.30,
  },
  {
    name: 'Światło', line: 'południe na ścianie okien',
    eye: [1.52, 3.62, 1.55], aim: [4.55, 1.75, 1.28], fov: 44, time: 0.24, bias: 0.22,
  },
  {
    name: 'Pracownia', line: 'biurko pod oknem',
    eye: [2.28, 2.35, 1.46], aim: [3.72, 0.42, 1.00], fov: 38, time: 0.32, roll: 0.4, bias: 0.28,
  },
  {
    name: 'Kuchnia', line: 'wnęka, kamień, mosiądz',
    eye: [2.72, 4.10, 1.56], aim: [3.62, 6.48, 1.12], fov: 42, time: 0.40, bias: 0.32,
  },
  {
    name: 'Próg ogrodu', line: 'szkło się rozsuwa',
    eye: [4.02, 3.19, 1.62], aim: [8.60, 2.90, 1.05], fov: 50, time: 0.48, bias: 0.30,
  },
  {
    name: 'Taras', line: 'cień pergoli',
    eye: [5.18, 6.32, 1.60], aim: [6.15, 1.35, 0.80], fov: 46, time: 0.60, roll: -0.4, bias: 0.06,
  },
  {
    name: 'Ogród', line: 'ścieżka, woda, rabata',
    eye: [7.72, -0.35, 1.56], aim: [9.15, 5.10, 0.35], fov: 48, time: 0.76,
  },
  {
    name: 'Zmierzch', line: 'światło wraca do środka',
    eye: [8.72, -2.35, 1.64], aim: [4.85, 2.45, 1.28], fov: 44, time: 0.99, roll: 0.5,
  },
];

export type Hotspot = {
  at: [number, number, number];
  tag: string;
  station: number;
  /** Only offer it while the visitor is somewhere near that part of the route. */
  from: number;
  to: number;
};

/** Anchored to things, not to empty air: the record player, the fig, the
 *  worktop, the daybed, the basin. */
export const HOTSPOTS: Hotspot[] = [
  { at: [1.30, 0.28, 0.80], tag: 'Gramofon', station: 1, from: -0.6, to: 1.8 },
  { at: [1.70, 3.26, 0.52], tag: 'Stolik', station: 1, from: 0.4, to: 2.6 },
  { at: [4.02, 3.46, 1.55], tag: 'Figowiec', station: 2, from: 1.4, to: 3.6 },
  { at: [3.45, 0.55, 0.90], tag: 'Biurko', station: 3, from: 2.2, to: 4.4 },
  { at: [3.80, 6.30, 1.10], tag: 'Aneks', station: 4, from: 3.3, to: 5.4 },
  { at: [5.85, 2.05, 0.34], tag: 'Leżanka', station: 6, from: 4.6, to: 7.4 },
  { at: [5.62, 5.45, 0.72], tag: 'Stół', station: 6, from: 5.0, to: 7.4 },
  { at: [8.54, 4.70, -0.06], tag: 'Sadzawka', station: 7, from: 6.2, to: 8.6 },
  { at: [8.75, -0.55, 2.60], tag: 'Brzozy', station: 7, from: 6.4, to: 8.8 },
];

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Camera rig: a spline through the stations, with the parameter eased so the
 *  camera decelerates into each one and leaves it again without a cut. */
export class Route {
  readonly count = STATIONS.length;
  private eyeCurve: T.CatmullRomCurve3;
  private aimCurve: T.CatmullRomCurve3;
  private tmpA = new T.Vector3();
  private tmpB = new T.Vector3();
  private exitCurve = new T.CatmullRomCurve3([
    bl(4.02, 3.19, 1.62), bl(4.82, 3.19, 1.62),
    bl(5.12, 3.90, 1.61), bl(5.18, 6.32, 1.60),
  ], false, 'centripetal');

  constructor() {
    const eyes = STATIONS.map((s) => bl(s.eye[0], s.eye[1], s.eye[2]));
    const aims = STATIONS.map((s) => bl(s.aim[0], s.aim[1], s.aim[2]));
    this.eyeCurve = new T.CatmullRomCurve3(eyes, false, 'centripetal', 0.4);
    this.aimCurve = new T.CatmullRomCurve3(aims, false, 'centripetal', 0.4);
  }

  /** `p` runs 0 .. count-1; whole numbers are stations. */
  sample(p: number) {
    const last = this.count - 1;
    const clamped = Math.min(Math.max(p, 0), last);
    const i = Math.min(Math.floor(clamped), last - 1);
    const f = clamped - i;
    const t = (i + smoother(f)) / last;
    this.eyeCurve.getPoint(t, this.tmpA);
    // Cross the actual clear opening before turning along the terrace.
    if (i === 5) this.exitCurve.getPointAt(smoother(f), this.tmpA);
    this.aimCurve.getPoint(t, this.tmpB);
    const a = STATIONS[i];
    const b = STATIONS[Math.min(i + 1, last)];
    const e = smoother(f);
    return {
      eye: this.tmpA,
      aim: this.tmpB,
      // A touch wider between stations: the room opens up as you travel and
      // settles as you arrive.
      fov: T.MathUtils.lerp(a.fov, b.fov, e) + Math.sin(Math.PI * e) * 1.6,
      roll: T.MathUtils.degToRad(
        T.MathUtils.lerp(a.roll ?? 0, b.roll ?? 0, e) * (1 - 0.55 * Math.sin(Math.PI * e)),
      ),
      time: T.MathUtils.lerp(a.time, b.time, e),
      bias: T.MathUtils.lerp(a.bias ?? 0, b.bias ?? 0, e),
      index: f < 0.5 ? i : Math.min(i + 1, last),
    };
  }

  /** Nearest station to an arbitrary world position, for returning from a walk. */
  nearest(pos: T.Vector3, visible?: (eye: T.Vector3) => boolean) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const s = STATIONS[i];
      const eye = this.tmpA.set(s.eye[0], s.eye[2], -s.eye[1]);
      if (visible && !visible(eye)) continue;
      const d = pos.distanceToSquared(eye);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
