import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { Settings } from './quality';
import { fetchAsset } from './lifetime';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { bl } from './tour';

/** Material names whose geometry is open strips — leaves, blades, curtains —
 *  and therefore must not be back-face culled. */
const TWO_SIDED = /leaf|grass|bloom|linen|climber|green|rug|throw/i;
/** Foliage that should move in the wind. */
const WINDY = /leaf|grass|bloom|climber/i;
/** Surfaces that are light sources rather than lit surfaces. */
const GLOWING = /lamp glow|opal|warm/i;

type ProtoGroup = { proto: string; offset: number; count: number };

/** glTF sanitises node names: "Window pane" arrives as "Window_pane". Every
 *  name test in here goes through this, or it silently never matches — which
 *  is how the glass panes ended up casting shadows and shutting the sunlight
 *  out of the apartment. */
const plain = (name: string) => name.replace(/_/g, ' ');

/** Nearest ancestor zone name, so a merged mesh knows which group it is in. */
function zoneOf(o: T.Object3D): string {
  for (let p: T.Object3D | null = o; p; p = p.parent) {
    const n = plain(p.name);
    if (n.startsWith('Zone ')) return n.slice(5);
  }
  return '';
}

/** Surfaces that must never write into the shadow map. */
const NO_SHADOW = /window pane|basin water|glow|bulb|diffuser|pendant|globe|screen/i;

export type PracticalSpec = {
  at: [number, number, number];
  color: number;
  power: number;
  distance: number;
};

/** Lamps that come on as the day runs out. Positions match the fixtures in
 *  the model, so the glow lands where the shade is. */
const PRACTICALS: PracticalSpec[] = [
  { at: [1.60, 3.30, 2.06], color: 0xffc98a, power: 13, distance: 6.5 },   // rice-paper pendant
  { at: [0.32, 2.86, 1.56], color: 0xffc07a, power: 7, distance: 4.2 },    // opal floor globe
  { at: [2.50, 0.35, 1.20], color: 0xffb977, power: 5, distance: 3.0 },    // mushroom desk lamp
  { at: [2.80, 6.18, 1.50], color: 0xffd2a0, power: 5, distance: 3.4 },    // under-cabinet
  { at: [3.80, 6.28, 1.68], color: 0xffc490, power: 4, distance: 2.6 },    // hood
  { at: [5.60, 2.20, 2.34], color: 0xffbe80, power: 9, distance: 7.0 },    // string lights, south
  { at: [5.60, 5.20, 2.34], color: 0xffbe80, power: 8, distance: 6.5 },    // string lights, north
  { at: [8.20, -0.60, 0.28], color: 0xffc48c, power: 5, distance: 4.5 },   // path bollards
  { at: [7.32, 3.60, 0.28], color: 0xffc48c, power: 4, distance: 4.0 },
];

/** Planar UVs across a screen's two largest axes. The exported panel carries
 *  whatever mapping the box modifier left behind, which is not a 0..1 fit. */
function fitScreenUV(mesh: T.Mesh) {
  const geo = mesh.geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const size = bb.getSize(new T.Vector3());
  const order = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
  const [u, v] = order[0] < order[1] ? [order[0], order[1]] : [order[1], order[0]];
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const du = size.getComponent(u) || 1;
  const dv = size.getComponent(v) || 1;
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getComponent(i, u) - bb.min.getComponent(u)) / du;
    uv[i * 2 + 1] = (pos.getComponent(i, v) - bb.min.getComponent(v)) / dv;
  }
  geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
}

/** What the desk monitor is showing. Drawn once into a canvas: a workspace
 *  window on the left and the signature set large on the right, because from
 *  where the tour stands the panel is about a hand wide and anything at true
 *  UI scale would be illegible mush. */
function monitorTexture(): T.Texture {
  const W = 1024;
  const H = 468;                                   // the panel is ~2.19 : 1
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#12161c');
  bg.addColorStop(1, '#080a0e');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  g.fillStyle = 'rgba(255, 255, 255, 0.06)';       // menu bar
  g.fillRect(0, 0, W, 34);
  g.fillStyle = 'rgba(232, 226, 214, 0.62)';
  g.font = '500 17px ui-monospace, Menlo, Consolas, monospace';
  g.fillText('atelier', 24, 23);
  g.textAlign = 'right';
  g.fillText('21:40', W - 24, 23);
  g.textAlign = 'left';

  const wx = 40;
  const wy = 74;
  const ww = 470;
  const wh = H - 150;
  g.fillStyle = 'rgba(255, 255, 255, 0.06)';       // window
  g.fillRect(wx, wy, ww, wh);
  g.fillStyle = 'rgba(255, 255, 255, 0.085)';
  g.fillRect(wx, wy, ww, 28);
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(wx + 22 + i * 19, wy + 14, 5, 0, Math.PI * 2);
    g.fillStyle = ['#c9705d', '#c6a15e', '#7f9b6d'][i];
    g.fill();
  }
  const rows: [number, number][] = [
    [0, 0.78], [1, 0.52], [1, 0.63], [2, 0.40],
    [1, 0.58], [0, 0.70], [0, 0.46],
  ];
  rows.forEach(([indent, width], i) => {
    g.fillStyle = i === 3 ? 'rgba(192, 160, 113, 0.65)' : 'rgba(232, 226, 214, 0.28)';
    g.fillRect(wx + 26 + indent * 22, wy + 56 + i * 30, (ww - 70) * width, 7);
  });

  const cx = wx + ww + (W - wx - ww) / 2 - 16;     // the signature
  g.textAlign = 'center';
  g.strokeStyle = 'rgba(222, 191, 138, 0.3)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx - 78, H / 2 - 46);
  g.lineTo(cx + 78, H / 2 - 46);
  g.stroke();
  g.fillStyle = 'rgba(232, 226, 214, 0.5)';
  g.font = '400 21px ui-serif, Georgia, "Times New Roman", serif';
  g.fillText('made by', cx, H / 2 - 18);
  g.fillStyle = 'rgba(222, 191, 138, 0.95)';
  g.font = '600 46px ui-monospace, Menlo, Consolas, monospace';
  g.fillText('APKMason', cx, H / 2 + 30);
  g.fillStyle = 'rgba(222, 191, 138, 0.55)';
  g.font = '500 27px ui-monospace, Menlo, Consolas, monospace';
  g.fillText('.dev', cx, H / 2 + 64);

  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function waterNormalTexture(): T.Texture {
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const h = new Float32Array(N * N);
  // Tileable ripples: only integer frequencies, so the texture wraps cleanly.
  const waves = [
    [3, 1, 0.6, 0.0], [1, 4, 0.45, 1.7], [5, 3, 0.28, 3.1],
    [2, 7, 0.2, 0.6], [8, 5, 0.12, 2.2],
  ];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0;
      for (const [fx, fy, a, ph] of waves) {
        v += a * Math.sin((x / N) * fx * Math.PI * 2 + (y / N) * fy * Math.PI * 2 + ph);
      }
      h[y * N + x] = v;
    }
  }
  const S = 1.6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const l = h[y * N + ((x - 1 + N) % N)];
      const r = h[y * N + ((x + 1) % N)];
      const u = h[((y - 1 + N) % N) * N + x];
      const d = h[((y + 1) % N) * N + x];
      const nx = (l - r) * S;
      const ny = (u - d) * S;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new T.CanvasTexture(c);
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.repeat.set(3, 4);
  tex.colorSpace = T.NoColorSpace;
  return tex;
}

export class World {
  readonly root = new T.Group();
  readonly lights: T.PointLight[] = [];
  /** Meshes the tour raycasts against for hotspot occlusion and floor picking. */
  readonly solids: T.Object3D[] = [];
  private windMaterials: T.Material[] = [];
  private glowing: { mat: T.MeshStandardMaterial; base: T.Color }[] = [];
  private waterMat: T.MeshStandardMaterial | null = null;
  private waterTex: T.Texture | null = null;
  private geometries = new Set<T.BufferGeometry>();
  private materials = new Set<T.Material>();
  private textures = new Set<T.Texture>();
  private upgraded = new Set<T.Material>();
  private disposed = false;
  private shadowMaterial = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
  private windShadowMaterial = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
  triangles = 0;
  instances = 0;

  async load(
    settings: Settings,
    renderer: T.WebGLRenderer,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ) {
    const draco = new DRACOLoader().setDecoderPath('draco/').setWorkerLimit(2);
    draco.preload();
    const loader = new GLTFLoader().setDRACOLoader(draco);

    const results = await Promise.allSettled([
      new Promise<{ scene: T.Group }>((res, rej) =>
        loader.load('model/atelier.glb', res as never, (e) => {
          if (e.total) onProgress(Math.min(0.92, (e.loaded / e.total) * 0.92));
        }, rej),
      ),
      fetchAsset('model/scatter.json', signal).then((r) => r.json() as Promise<{ stride: number; groups: ProtoGroup[] }>),
      fetchAsset('model/scatter.bin', signal).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
    ]);
    draco.dispose();
    const [modelResult, indexResult, dataResult] = results;
    if (modelResult.status === 'fulfilled') this.own(modelResult.value.scene);
    const failure = results.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected' || signal?.aborted || this.disposed) {
      this.dispose();
      throw failure?.status === 'rejected' ? failure.reason : new DOMException('Aborted', 'AbortError');
    }
    if (modelResult.status !== 'fulfilled' || indexResult.status !== 'fulfilled' || dataResult.status !== 'fulfilled') throw new Error('Incomplete model');
    const gltf = modelResult.value, scatterIndex = indexResult.value, scatterData = dataResult.value;
    if (scatterIndex.stride !== 10 || !Array.isArray(scatterIndex.groups) || scatterIndex.groups.some(g =>
      !Number.isInteger(g.offset) || !Number.isInteger(g.count) || g.offset < 0 || g.count < 0 ||
      (g.offset + g.count) * 10 > scatterData.length)) throw new Error('Invalid scatter data');
    onProgress(0.95);

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const protos = new Map<string, T.Object3D>();

    // Only the top-level prototype node. A multi-material prototype arrives as
    // a Group whose children are also PROTO_-named; collecting those too meant
    // detaching them from their own parent a moment later, which silently
    // emptied every multi-material prototype.
    gltf.scene.traverse((o) => {
      if (!o.name.startsWith('PROTO_')) return;
      if (o.parent && o.parent.name.startsWith('PROTO_')) return;
      protos.set(o.name, o);
    });

    gltf.scene.traverse((o) => {
      if (!(o as T.Mesh).isMesh) return;
      const mesh = o as T.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) this.upgradeMaterial(m as T.MeshStandardMaterial, maxAniso);
      if (!o.name.startsWith('PROTO_')) {
        const name = plain(o.name);
        const far = zoneOf(o) === 'far';
        const noShadow = far || NO_SHADOW.test(name);
        mesh.castShadow = settings.shadows && !noShadow;
        mesh.receiveShadow = !far;
        if (!far && !NO_SHADOW.test(name)) {
          if (!mesh.geometry.boundsTree) computeBoundsTree.call(mesh.geometry);
          mesh.raycast = acceleratedRaycast;
          this.solids.push(mesh);
        }
        const pos = mesh.geometry.getAttribute('position');
        if (pos) this.triangles += (mesh.geometry.index?.count ?? pos.count) / 3;
      }
    });

    // The desk monitor gets its own material, so the shared `glass` used by
    // the cooktop, the oven door and the spice jars is left untouched.
    const panel = gltf.scene.getObjectByName('MonitorScreen') as T.Mesh | null;
    if (panel?.isMesh) {
      fitScreenUV(panel);
      const map = monitorTexture();
      const screen = new T.MeshStandardMaterial({
        map,
        emissiveMap: map,
        emissive: new T.Color(0xffffff),
        emissiveIntensity: 0.9,
        roughness: 0.34,
        metalness: 0,
        toneMapped: true,
      });
      panel.material = screen;
      // A self-lit panel taking a hard shadow map reads as a smear, not
      // as shading; the vine above it was landing across the signature.
      panel.castShadow = false;
      panel.receiveShadow = false;
      this.textures.add(map);
      this.materials.add(screen);
    }

    // Prototypes leave the graph; their instances take over.
    for (const node of protos.values()) node.parent?.remove(node);
    this.root.add(gltf.scene);

    this.buildInstances(protos, scatterIndex.groups, scatterData, scatterIndex.stride, settings);
    this.buildPracticals();
    this.materials.add(this.shadowMaterial);
    this.materials.add(this.windShadowMaterial);
    this.applyWind(this.windShadowMaterial);
    this.own(this.root);
    // Static architecture and planting transforms never change; wind is in the shader.
    this.root.updateMatrixWorld(true);
    this.root.traverse(o => { o.matrixAutoUpdate = false; });
    this.root.traverse(o => {
      if (!(o as T.Mesh).isMesh) return;
      const material = (o as T.Mesh).material;
      const windy = (Array.isArray(material) ? material : [material]).some(m => WINDY.test(m.name));
      (o as T.Mesh).customDepthMaterial = windy ? this.windShadowMaterial : this.shadowMaterial;
      if ((Array.isArray(material) ? material : [material]).every(m => !m.transparent || m.opacity >= 0.5)) o.layers.enable(1);
    });
    onProgress(1);
    return this;
  }

  private upgradeMaterial(m: T.MeshStandardMaterial, maxAniso: number) {
    if (!m || !m.isMeshStandardMaterial) return;
    if (this.upgraded.has(m)) return;
    this.upgraded.add(m);
    const name = m.name || '';
    m.envMapIntensity = 1.0;
    if (m.map) {
      m.map.anisotropy = Math.min(4, maxAniso);
      m.map.colorSpace = T.SRGBColorSpace;
    }
    if (TWO_SIDED.test(name)) m.side = T.DoubleSide;

    if (WINDY.test(name)) {
      this.applyWind(m);
      // A dark leaf mirroring a bright sky goes teal; foliage takes far less
      // of the environment than a polished surface does.
      m.envMapIntensity = 0.42;
      // Foliage catches a little light from behind; without it every leaf mass
      // goes flat black against the sky.
      m.emissive = new T.Color(m.color).multiplyScalar(0.10);
    }
    if (GLOWING.test(name)) {
      m.emissiveIntensity = 0;
      this.glowing.push({ mat: m, base: m.emissive.clone() });
      m.emissive = new T.Color(0, 0, 0);
      m.toneMapped = true;
    }
    if (/window glass/.test(name)) {
      m.transparent = true;
      // A constant white film over the garden reads as dirt; the reflection
      // is what sells the glass, so the film is barely there.
      m.opacity = 0.045;
      m.roughness = 0.03;
      m.metalness = 0;
      m.envMapIntensity = 1.5;
      m.depthWrite = false;
      m.side = T.DoubleSide;
    }
    if (/smoked glass/.test(name)) {
      m.transparent = true;
      m.opacity = 0.42;
      m.depthWrite = false;
    }
    if (/garden water/.test(name)) {
      this.waterTex = waterNormalTexture();
      this.textures.add(this.waterTex);
      m.normalMap = this.waterTex;
      m.normalScale = new T.Vector2(0.16, 0.16);
      m.roughness = 0.04;
      m.metalness = 0.02;
      m.envMapIntensity = 2.6;
      this.waterMat = m;
    }
  }

  /** Foliage sway. Instanced meshes get a per-clump phase from their own
   *  world position, so a field of grass never moves as one object. */
  private applyWind(m: T.Material) {
    const uniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
    (m as T.MeshStandardMaterial).userData.uniforms = uniforms;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uTime;
           uniform float uWind;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           #ifdef USE_INSTANCING
             vec3 wOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           #else
             vec3 wOrigin = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
           #endif
           float phase = wOrigin.x * 0.62 + wOrigin.z * 0.47;
           // Height above the clump's own base drives how far a blade travels.
           float lift = clamp(transformed.y / 0.9, 0.0, 1.0);
           float gust = 0.62 + 0.38 * sin(uTime * 0.23 + wOrigin.x * 0.11);
           float s = sin(uTime * 1.55 + phase) + 0.45 * sin(uTime * 3.1 + phase * 1.9);
           float c = cos(uTime * 1.28 + phase * 0.8);
           float amp = uWind * gust * lift * lift * 0.055;
           transformed.x += s * amp;
           transformed.z += c * amp * 0.65;
           transformed.y -= abs(s) * amp * 0.18;`,
        );
    };
    m.customProgramCacheKey = () => 'wind';
    this.windMaterials.push(m);
  }

  private buildInstances(
    protos: Map<string, T.Object3D>,
    groups: ProtoGroup[],
    data: Float32Array,
    stride: number,
    settings: Settings,
  ) {
    const pos = new T.Vector3();
    const quat = new T.Quaternion();
    const scale = new T.Vector3();
    const mat = new T.Matrix4();
    const tint = new T.Color();

    for (const g of groups) {
      const node = protos.get(g.proto);
      if (!node) continue;
      const meshes: T.Mesh[] = [];
      node.updateWorldMatrix(true, false);
      node.traverse((o) => {
        if ((o as T.Mesh).isMesh) meshes.push(o as T.Mesh);
      });
      if (!meshes.length) continue;

      // Ground cover is where the instance budget goes, so that is where a
      // weaker machine gives some back.
      const isGroundCover = /grass_tuft|grass_edge|leaf_litter|pebble/.test(g.proto);
      const keep = isGroundCover ? settings.scatter : 1;
      const indices: number[] = [];
      // Fractional decimation rather than a stride: 0.72 has to mean 72 %, and
      // Math.round(1 / 0.72) is 1, which quietly kept everything.
      let acc = 0;
      for (let i = 0; i < g.count; i++) {
        acc += keep;
        if (acc >= 1) {
          acc -= 1;
          indices.push(i);
        }
      }
      if (!indices.length) continue;

      for (const src of meshes) {
        src.updateWorldMatrix(true, false);
        const geo = src.geometry.clone();
        geo.applyMatrix4(src.matrixWorld);
        const material = src.material as T.Material;
        const im = new T.InstancedMesh(geo, material, indices.length);
        im.name = `inst:${g.proto}`;
        im.castShadow = settings.shadows && !isGroundCover;
        im.receiveShadow = true;
        im.instanceMatrix.setUsage(T.StaticDrawUsage);

        for (let k = 0; k < indices.length; k++) {
          const base = (g.offset + indices[k]) * stride;
          pos.set(data[base], data[base + 1], data[base + 2]);
          quat.set(data[base + 3], data[base + 4], data[base + 5], data[base + 6]);
          scale.set(data[base + 7], data[base + 8], data[base + 9]);
          mat.compose(pos, quat, scale);
          im.setMatrixAt(k, mat);
          // A planting of identical clones is the giveaway; a few percent of
          // colour spread reads as different plants of the same species.
          const v = 0.82 + ((Math.sin(indices[k] * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.36;
          tint.setRGB(v, v * (0.97 + 0.06 * (((indices[k] * 7) % 5) / 5)), v * 0.97);
          im.setColorAt(k, tint);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        // Include the maximum vertex displacement from the wind shader.
        if (im.boundingSphere) im.boundingSphere.radius += 0.16;
        this.root.add(im);
        this.geometries.add(geo);
        this.instances += indices.length;
        const p = geo.getAttribute('position');
        if (p) this.triangles += ((geo.index?.count ?? p.count) / 3) * indices.length;
      }
    }
  }

  private buildPracticals() {
    for (const spec of PRACTICALS) {
      const l = new T.PointLight(spec.color, 0, spec.distance, 2);
      l.position.copy(bl(spec.at[0], spec.at[1], spec.at[2]));
      l.castShadow = false;
      l.visible = true;
      this.lights.push(l);
      this.root.add(l);
    }
  }

  /** Called every frame with the current time-of-day and elapsed seconds. */
  update(elapsed: number, practical: number, windScale: number) {
    for (const m of this.windMaterials) {
      const u = (m as T.MeshStandardMaterial).userData.uniforms;
      if (u) {
        u.uTime.value = elapsed;
        u.uWind.value = windScale;
      }
    }
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const on = practical > 0.015;
      l.visible = true;
      l.intensity = on ? PRACTICALS[i].power * practical : 0;
    }
    for (const g of this.glowing) {
      g.mat.emissive.copy(g.base);
      g.mat.emissiveIntensity = 0.12 + 2.6 * practical;
    }
    if (this.waterTex) {
      this.waterTex.offset.set(elapsed * 0.006, elapsed * 0.011);
      this.waterTex.needsUpdate = false;
    }
    if (this.waterMat) {
      const s = 0.10 + 0.05 * Math.sin(elapsed * 0.4);
      this.waterMat.normalScale.set(s, s);
    }
  }

  setShadows(on: boolean) {
    this.root.traverse((o) => {
      const m = o as T.Mesh;
      if (!m.isMesh && !(m as unknown as T.InstancedMesh).isInstancedMesh) return;
      const name = plain(o.name);
      if (zoneOf(o) === 'far' || NO_SHADOW.test(name)) {
        m.castShadow = false;
        return;
      }
      if (/^inst:PROTO_(grass_tuft|grass_edge|leaf_litter|pebble)/.test(o.name)) {
        m.castShadow = false;
        return;
      }
      m.castShadow = on;
    });
  }

  private own(root: T.Object3D) {
    root.traverse((o) => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      this.geometries.add(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if ((v as T.Texture)?.isTexture) this.textures.add(v as T.Texture);
        this.materials.add(mat);
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.materials.add(this.shadowMaterial);
    this.materials.add(this.windShadowMaterial);
    this.own(this.root);
    this.root.traverse(o => { if ((o as T.InstancedMesh).isInstancedMesh) (o as T.InstancedMesh).dispose(); });
    for (const g of this.geometries) { disposeBoundsTree.call(g); g.dispose(); }
    for (const m of this.materials) m.dispose();
    const bitmaps = new Set<ImageBitmap>();
    for (const t of this.textures) {
      if (typeof ImageBitmap !== 'undefined' && t.source.data instanceof ImageBitmap) bitmaps.add(t.source.data);
      t.dispose();
    }
    for (const b of bitmaps) b.close();
    this.geometries.clear(); this.materials.clear(); this.textures.clear(); this.upgraded.clear();
    this.windMaterials.length = this.glowing.length = this.solids.length = this.lights.length = 0;
    this.waterMat = this.waterTex = null;
    this.root.clear();
  }
}
