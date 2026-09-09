import * as T from 'three';

/** One keyframe of the light rig. Everything the scene needs to look like a
 *  particular hour is here, so the whole day is one interpolation. */
type Key = {
  t: number;
  elev: number;          // degrees above the horizon
  azim: number;          // degrees, 0 = +X in the Blender frame
  sun: number;           // hex
  sunPower: number;
  zenith: number;
  horizon: number;
  ground: number;
  /** The hemisphere light's sky colour. Kept far less saturated than the sky
   *  itself, because a strong blue fill turns every dark surface teal. */
  fill: number;
  ambient: number;
  env: number;
  exposure: number;
  /** How strongly the lamps inside and in the garden are burning. */
  practical: number;
  fog: number;
};

const KEYS: Key[] = [
  { t: 0.00, elev: 38, azim: 58, sun: 0xfff2dc, sunPower: 5.4, zenith: 0x5f8dc0,
    horizon: 0xdde2df, ground: 0x9c9a88, fill: 0xc6cfd4, ambient: 0.17, env: 0.36, exposure: 1.72, practical: 0.16, fog: 0.0042 },
  { t: 0.44, elev: 33, azim: 40, sun: 0xffeed2, sunPower: 5.6, zenith: 0x5c8abd,
    horizon: 0xe2e2d8, ground: 0x9b9884, fill: 0xcbd0cf, ambient: 0.17, env: 0.36, exposure: 1.73, practical: 0.15, fog: 0.0040 },
  { t: 0.72, elev: 22, azim: 18, sun: 0xffd7a0, sunPower: 5.0, zenith: 0x5f83b0,
    horizon: 0xeddac0, ground: 0x968d74, fill: 0xd0c6b4, ambient: 0.16, env: 0.34, exposure: 1.80, practical: 0.24, fog: 0.0054 },
  { t: 0.91, elev: 8.5, azim: 0, sun: 0xffa462, sunPower: 3.6, zenith: 0x496a95,
    horizon: 0xf2b274, ground: 0x776a58, fill: 0xc09a76, ambient: 0.13, env: 0.29, exposure: 1.95, practical: 0.74, fog: 0.0084 },
  { t: 1.00, elev: -2.5, azim: -13, sun: 0xff8348, sunPower: 0.55, zenith: 0x1e2f4e,
    horizon: 0xc26a3d, ground: 0x3c392f, fill: 0x5f5049, ambient: 0.09, env: 0.19, exposure: 2.20, practical: 1.0, fog: 0.0112 },
];

const cA = new T.Color();
const cB = new T.Color();

function lerpKeys(t: number): Key {
  t = Math.min(Math.max(t, 0), 1);
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const mixHex = (x: number, y: number) => {
    cA.setHex(x, T.SRGBColorSpace);
    cB.setHex(y, T.SRGBColorSpace);
    return cA.lerp(cB, f).getHex(T.SRGBColorSpace);
  };
  const L = (x: number, y: number) => x + (y - x) * f;
  return {
    t,
    elev: L(a.elev, b.elev), azim: L(a.azim, b.azim),
    sun: mixHex(a.sun, b.sun), sunPower: L(a.sunPower, b.sunPower),
    zenith: mixHex(a.zenith, b.zenith), horizon: mixHex(a.horizon, b.horizon),
    ground: mixHex(a.ground, b.ground), fill: mixHex(a.fill, b.fill),
    ambient: L(a.ambient, b.ambient), env: L(a.env, b.env),
    exposure: L(a.exposure, b.exposure),
    practical: L(a.practical, b.practical), fog: L(a.fog, b.fog),
  };
}

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;             // always at the far plane
}`;

const FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uGround, uSun, uSunDir;
uniform float uGlow;
void main() {
  vec3 d = normalize(vDir);
  float up = pow(smoothstep(-0.06, 0.62, d.y), 0.72);
  vec3 col = mix(uHorizon, uZenith, up);
  col = mix(uGround, col, smoothstep(-0.26, -0.005, d.y));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSun * pow(s, 1400.0) * 26.0;             // the disc
  col += uSun * pow(s, 9.0) * 0.42 * uGlow;        // the flare around it
  col += uSun * pow(s, 2.2) * 0.13 * uGlow;        // the whole-sky warmth
  // A very slight vertical banding break, so the gradient never posterises.
  col += (fract(sin(dot(d.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.006;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  readonly mesh: T.Mesh;
  readonly sun = new T.DirectionalLight(0xffffff, 3);
  readonly hemi = new T.HemisphereLight(0xbcd4ef, 0x5b5344, 0.6);
  readonly uniforms = {
    uZenith: { value: new T.Color() },
    uHorizon: { value: new T.Color() },
    uGround: { value: new T.Color() },
    uSun: { value: new T.Color() },
    uSunDir: { value: new T.Vector3(0, 1, 0) },
    uGlow: { value: 1 },
  };
  /** Read by the world to drive lamps and emissive surfaces. */
  practical = 0;
  exposure = 1;
  fogDensity = 0.004;
  horizonColor = new T.Color();

  private envTarget: T.WebGLRenderTarget | null = null;
  private envScene = new T.Scene();
  private lastApplied = -1;
  private direction = new T.Vector3();
  private lastEnvTime = -1;
  private lastEnvAt = 0;
  private pmrem: T.PMREMGenerator;

  constructor(renderer: T.WebGLRenderer, shadowSize: number) {
    const geo = new T.SphereGeometry(1, 32, 20);
    const mat = new T.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: T.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
      fog: false,
    });
    this.mesh = new T.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);

    // A second copy lives in a bare scene used only to bake the environment.
    const envMesh = new T.Mesh(geo, mat.clone());
    (envMesh.material as T.ShaderMaterial).uniforms = this.uniforms;
    (envMesh.material as T.ShaderMaterial).depthTest = true;
    envMesh.scale.setScalar(60);
    this.envScene.add(envMesh);

    this.sun.castShadow = true;
    this.configureShadow(shadowSize);
    this.pmrem = new T.PMREMGenerator(renderer);

  }

  configureShadow(size: number) {
    const s = this.sun.shadow;
    s.mapSize.set(size, size);
    // The frustum covers the apartment, the terrace and the near garden; the
    // deep border and the treeline read fine on ambient alone.
    const c = s.camera;
    c.left = -8.5; c.right = 8.5; c.top = 9.5; c.bottom = -9.5;
    c.near = 0.5; c.far = 46;
    c.updateProjectionMatrix();
    s.bias = -0.0006;
    s.normalBias = 0.022;
    s.blurSamples = 8;
  }

  /** Move the whole day to `t`. Returns true when the environment map was
   *  re-baked, which the caller may want to throttle. */
  apply(t: number, scene: T.Scene, allowEnv: boolean, minInterval = 190) {
    if (t === this.lastApplied && (!allowEnv || (this.envTarget !== null && Math.abs(t - this.lastEnvTime) <= 0.045))) return false;
    this.lastApplied = t;
    const k = lerpKeys(t);
    const el = T.MathUtils.degToRad(k.elev);
    const az = T.MathUtils.degToRad(k.azim);
    // Blender frame first, then to Y-up: (x, y, z) -> (x, z, -y).
    const bx = Math.cos(el) * Math.cos(az);
    const by = Math.cos(el) * Math.sin(az);
    const bz = Math.sin(el);
    const dir = this.direction.set(bx, bz, -by).normalize();

    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uZenith.value.setHex(k.zenith, T.SRGBColorSpace);
    this.uniforms.uHorizon.value.setHex(k.horizon, T.SRGBColorSpace);
    this.uniforms.uGround.value.setHex(k.ground, T.SRGBColorSpace);
    this.uniforms.uSun.value.setHex(k.sun, T.SRGBColorSpace);
    this.uniforms.uGlow.value = 0.5 + 1.5 * Math.max(0, 1 - k.elev / 40);

    this.sun.color.setHex(k.sun, T.SRGBColorSpace);
    this.sun.intensity = Math.max(0, k.sunPower);
    this.sun.visible = k.sunPower > 0.02;
    // Aim the shadow frustum at the terrace, which is the busiest ground.
    this.sun.target.position.set(5.6, 0.6, -2.6);
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 24);

    this.hemi.color.setHex(k.fill, T.SRGBColorSpace);
    this.hemi.groundColor.setHex(k.ground, T.SRGBColorSpace);
    this.hemi.intensity = k.ambient;

    this.horizonColor.setHex(k.horizon, T.SRGBColorSpace);
    this.practical = k.practical;
    this.exposure = k.exposure;
    this.fogDensity = k.fog;

    if (scene.fog instanceof T.FogExp2) {
      scene.fog.color.copy(this.horizonColor);
      scene.fog.density = k.fog;
    }
    // The environment map is the only stand-in for bounced light, so it
    // carries most of the interior. GTAO puts the corners back.
    scene.environmentIntensity = k.env;

    // Re-baking the environment is a few milliseconds; during a fast scroll it
    // would otherwise fire every frame and show up as stutter.
    const now = performance.now();
    if (allowEnv && (!this.envTarget || (Math.abs(t - this.lastEnvTime) > 0.045 && now - this.lastEnvAt > minInterval))) {
      this.lastEnvTime = t;
      this.lastEnvAt = now;
      const prev = this.envTarget;
      this.envTarget = this.pmrem.fromScene(this.envScene, 0.03, 1, 100, { size: 128 });
      scene.environment = this.envTarget.texture;
      prev?.dispose();
      return true;
    }
    return false;
  }

  dispose() {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sun.shadow.dispose();
    for (const child of this.envScene.children) ((child as T.Mesh).material as T.Material).dispose();
    this.envScene.clear();
    this.mesh.geometry.dispose();
    (this.mesh.material as T.Material).dispose();
  }
}
