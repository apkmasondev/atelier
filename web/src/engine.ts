import * as T from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { ArchitectureAO } from './occlusion';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

import { Sky } from './sky';
import { World } from './world';
import { NavGrid, Walker } from './walk';
import { Route, STATIONS, HOTSPOTS } from './tour';
import { Ui } from './ui';
import { detectTier, settingsFor, Governor, type Settings } from './quality';
import { Lifetime } from './lifetime';
import { Ambience } from './ambience';

/** Final look pass.
 *
 *  three's AgX is neutral by design; a photographed interior gets a grade on
 *  top. This is that grade: a contrast curve around a mid pivot, a small
 *  saturation lift, a cool/warm split between shadows and highlights, then a
 *  vignette and enough grain that the plaster and the sky never band.
 */
const GrainShader = {
  uniforms: {
    tDiffuse: { value: null as T.Texture | null },
    uTime: { value: 0 },
    uAmount: { value: 0.026 },
    uVignette: { value: 0.95 },
    uContrast: { value: 1.2 },
    uSaturation: { value: 1.1 },
    uLift: { value: 0.004 },
    uShadowTint: { value: new T.Vector3(0.965, 0.985, 1.045) },
    uHighTint: { value: new T.Vector3(1.035, 1.008, 0.972) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uAmount, uVignette, uContrast, uSaturation, uLift;
    uniform vec3 uShadowTint, uHighTint;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = (c - 0.5) * uContrast + 0.5 + uLift;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c *= mix(uShadowTint, uHighTint, smoothstep(0.05, 0.8, l));
      vec2 d = vUv - 0.5;
      float vig = (1.0 - smoothstep(0.14, 0.9, dot(d, d) * uVignette * 2.2));
      c *= mix(0.7, 1.0, vig);
      float n = fract(sin(dot(vUv * vec2(1372.0, 913.0) + uTime * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * uAmount;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

type Mode = 'tour' | 'walk' | 'returning';

export class Experience {
  renderer: T.WebGLRenderer;
  scene = new T.Scene();
  private camera = new T.PerspectiveCamera(44, 1, 0.06, 260);
  composer: EffectComposer | null = null;
  private grain: ShaderPass | null = null;
  sky: Sky;
  world = new World();
  private ui: Ui;
  private ambience = new Ambience();
  private route = new Route();
  private nav!: NavGrid;
  private walker!: Walker;
  settings: Settings;
  private governor: Governor;

  private mode: Mode = 'tour';
  private routeP = 0;
  private targetP = 0;
  private routeV = 0;
  private idle = 0;
  private started = false;

  // Free look, which always decays back to the route's own framing.
  private lookYaw = 0;
  private lookPitch = 0;
  private parallax = new T.Vector2();
  private parallaxTarget = new T.Vector2();
  private dragging = false;
  private dragId: number | null = null;
  private lastPointer = new T.Vector2();
  private touchAxis: 'none' | 'route' | 'look' = 'none';

  private marker!: T.Group;
  private markerAt = new T.Vector3();
  private markerBl: [number, number] = [0, 0];
  private markerHot = false;
  private hoverTimer = 0;
  private pointerNdc = new T.Vector2(0, -2);
  private ray = new T.Raycaster();
  private hotspotVisible = new Array(HOTSPOTS.length).fill(true);
  private occlusionClock = 0;
  private shadowClock = 0;

  private blend = 0;
  private blendFrom = { pos: new T.Vector3(), quat: new T.Quaternion(), fov: 44, time: 0.06 };
  private currentTime = 0.06;
  private returnOccluded = false;

  private clock = new T.Clock();
  private frame = 0;
  private disposed = false;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private showStats = false;
  private noComposer = false;
  private noEnv = false;
  private abort = new Lifetime();
  private scratch = new T.Vector3();
  private targetQuat = new T.Quaternion();
  private dragOrigin = new T.Vector2();
  private dragDistance = 0;
  private coarse = matchMedia('(pointer: coarse)').matches;
  private statsAt = 0;
  private contextLost = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.ray.firstHitOnly = true;
    this.ui = new Ui();
    // ?tier=low|medium|high and ?fx=0 exist for testing on a machine that is
    // not the one the visitor has.
    const params = new URLSearchParams(location.search);
    const forced = params.get('tier');
    const tier = (forced === 'low' || forced === 'medium' || forced === 'high')
      ? forced
      : detectTier(this.renderer.getContext());
    this.settings = settingsFor(tier);
    if (params.get('fx') === '0') {
      this.settings.ao = false;
      this.settings.bloom = false;
    }
    this.noComposer = params.get('composer') === '0';
    this.noEnv = params.get('env') === '0';
    this.governor = new Governor(this.settings, (what) => this.dropEffect(what));

    this.renderer.outputColorSpace = T.SRGBColorSpace;
    // AgX holds a blown window and a lit interior in the same frame far
    // better than ACES, and it is what the Blender scene is graded in.
    this.renderer.toneMapping = T.AgXToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    // Nothing in the scene moves except the sun and the wind in the leaves, so
    // the shadow map does not need re-rendering sixty times a second. Refreshing
    // it eight times a second is invisible and saves a whole extra pass over
    // every shadow caster each frame.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setPixelRatio(this.governor.dpr);
    // The composer renders several times per frame; without this the counter
    // only ever reports the last full-screen quad.
    this.renderer.info.autoReset = false;

    this.scene.fog = new T.FogExp2(0xd2dade, 0.004);
    this.sky = new Sky(this.renderer, this.settings.shadowSize);
    this.scene.add(this.sky.sun, this.sky.sun.target, this.sky.hemi);
    this.camera.add(this.sky.mesh);
    this.scene.add(this.camera);

    this.buildMarker();
    this.resize();
    // Also cover context loss while assets or asynchronous shaders are loading.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.ui.fail('Przeglądarka przerwała rysowanie 3D. Odśwież stronę.');
      this.dispose();
    }, { signal: this.abort.signal });
  }

  async start() {
    try {
      const [nav] = await Promise.all([
        NavGrid.load(this.abort.signal),
        this.world.load(this.settings, this.renderer, (f) => this.ui.progress(f * 0.97), this.abort.signal),
      ]);
      if (this.disposed) return;
      this.nav = nav;
      this.walker = new Walker(nav, this.reduced);
      this.scene.add(this.world.root);
      this.world.setShadows(this.settings.shadows);
      this.sky.apply(STATIONS[0].time, this.scene, !this.noEnv);
      this.renderer.toneMappingExposure = this.sky.exposure * (1 + (STATIONS[0].bias ?? 0));
      this.world.update(0, this.sky.practical, this.reduced ? 0.35 : 1);
      this.buildComposer();

      // Warm the shader cache before the first visible frame, so the opening
      // move is not a slideshow.
      this.applyTourCamera(0);
      this.renderer.shadowMap.needsUpdate = true;
      await this.renderer.compileAsync(this.scene, this.camera);
      if (this.disposed) return;
      if (this.composer) this.composer.render(0);
      else this.renderer.render(this.scene, this.camera);
      performance.mark('atelier:first-scene');
      this.ui.progress(1);
    } catch (err) {
      if (this.disposed) return;
      console.error(err);
      this.ui.fail('Nie udało się wczytać sceny. Odśwież stronę lub sprawdź połączenie.');
      this.dispose();
      return;
    }

    this.bindEvents();
    this.ui.onStation = (i) => this.goTo(i);
    this.ui.onWalkToggle = () => {
      if (this.mode === 'walk') this.leaveWalk();
      else this.enterWalkHere();
    };
    this.ui.onSoundToggle = async () => {
      const state = await this.ambience.toggle();
      if (state === null) {
        this.ui.hint('Przeglądarka zablokowała dźwięk', 3600);
        this.ui.soundState(false);
      } else {
        this.ui.soundState(state);
      }
    };
    this.ui.walkState(false);
    this.ui.soundState(false);
    this.ui.chapter(0);
    this.ui.reveal();
    // The opening move begins on its own: the visitor arrives already inside.
    this.abort.later(() => {
      if (!this.started && this.mode === 'tour') this.targetP = 0.16;
    }, 1500);
    this.clock.start();
    this.frame = requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------ composition
  private buildComposer() {
    this.disposeComposer();
    this.composer = null;
    this.grain = null;
    if (this.noComposer) return;

    const size = new T.Vector2();
    this.renderer.getDrawingBufferSize(size);
    const target = new T.WebGLRenderTarget(innerWidth, innerHeight, {
      type: T.HalfFloatType,
      samples: this.settings.msaa,
      colorSpace: T.LinearSRGBColorSpace,
    });
    const composer = new EffectComposer(this.renderer, target);
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));

    if (this.settings.ao) {
      try {
        const gtao = new ArchitectureAO(this.scene, this.camera, size.x, size.y);
        gtao.normalMaterial.side = T.DoubleSide;
        gtao.blendIntensity = 0.88;
        // Half a metre of gather is right for a room this size: it darkens the
        // wall-ceiling junction and under the furniture without smearing.
        gtao.updateGtaoMaterial({
          radius: 0.55, distanceExponent: 1.6, thickness: 0.9,
          scale: 1.35, samples: this.settings.tier === 'high' ? 16 : 9,
          screenSpaceRadius: false,
        });
        composer.addPass(gtao);
      } catch (e) {
        console.warn('GTAO unavailable', e);
        this.settings.ao = false;
      }
    }
    if (this.settings.bloom) {
      // Only the lamps and the sun itself should bloom, and only just.
      const bloom = new UnrealBloomPass(size, 0.13, 0.8, 1.05);
      composer.addPass(bloom);
    }
    composer.addPass(new OutputPass());
    // With no multisampling in the target there is no antialiasing at all, so
    // the cheap tier pays for FXAA instead. It runs after tone mapping, on
    // low dynamic range, which is where FXAA belongs.
    if (!this.settings.msaa) {
      try {
        composer.addPass(new FXAAPass());
      } catch (e) {
        console.warn('FXAA unavailable', e);
      }
    }
    const grain = new ShaderPass(GrainShader);
    grain.renderToScreen = true;
    composer.addPass(grain);
    this.grain = grain;
    this.composer = composer;
    composer.setPixelRatio(this.governor.dpr);
    composer.setSize(innerWidth, innerHeight);
  }

  private disposeComposer() {
    for (const pass of this.composer?.passes ?? []) {
      pass.dispose();
      if (pass instanceof UnrealBloomPass) pass.materialHighPassFilter.dispose();
    }
    this.composer?.dispose();
  }

  private dropEffect(what: 'ao' | 'bloom' | 'shadows') {
    if (what === 'shadows') {
      this.renderer.shadowMap.enabled = false;
      this.settings.shadows = false;
      this.world.setShadows(false);
      this.sky.sun.shadow.dispose();
      this.sky.sun.shadow.map = null;
      return;
    }
    this.buildComposer();
  }

  private buildMarker() {
    this.marker = new T.Group();
    const mk = (inner: number, outer: number, opacity: number) => {
      const g = new T.RingGeometry(inner, outer, 48);
      const m = new T.MeshBasicMaterial({
        color: 0xf2ece0, transparent: true, opacity, depthWrite: false,
        depthTest: false, side: T.DoubleSide, toneMapped: false,
      });
      const mesh = new T.Mesh(g, m);
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    };
    this.marker.add(mk(0.28, 0.288, 0.55), mk(0.0, 0.022, 0.8));
    this.marker.visible = false;
    this.marker.renderOrder = 900;
    this.scene.add(this.marker);
  }

  // ------------------------------------------------------------------ input
  private bindEvents() {
    const signal = this.abort.signal;
    const opts = { signal, passive: false } as AddEventListenerOptions;

    addEventListener('resize', () => this.resize(), { signal });
    addEventListener('orientationchange', () => this.abort.later(() => this.resize(), 220), { signal });

    addEventListener('wheel', (e: WheelEvent) => {
      if (this.mode !== 'tour') return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
      this.nudge(px * 0.0017);
    }, opts);

    addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && (e.target.closest('input, textarea, select, [contenteditable]') ||
          (e.target.closest('button, a') && (e.code === 'Enter' || e.code === 'Space')))) return;
      if (e.code === 'Backquote') {
        this.showStats = !this.showStats;
        this.ui.stats(this.showStats ? '' : null);
        return;
      }
      if (this.mode === 'walk') {
        this.walker.setKey(e.code, true);
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
          e.preventDefault();
        }
        if (e.code === 'Escape' || e.code === 'KeyQ') this.leaveWalk();
        return;
      }
      switch (e.code) {
        case 'ArrowDown': case 'PageDown': case 'Space':
          e.preventDefault(); this.goTo(Math.round(this.targetP) + 1); break;
        case 'ArrowUp': case 'PageUp':
          e.preventDefault(); this.goTo(Math.round(this.targetP) - 1); break;
        case 'Home': this.goTo(0); break;
        case 'End': this.goTo(STATIONS.length - 1); break;
        case 'KeyW': case 'Enter':
          e.preventDefault(); this.enterWalkHere(); break;
      }
    }, opts);
    addEventListener('keyup', (e) => this.walker?.setKey(e.code, false), { signal });

    this.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || (this.dragId !== null && !(this.mode === 'walk' && e.pointerType === 'touch' && e.clientX < innerWidth * 0.42))) return;
      this.canvas.setPointerCapture?.(e.pointerId);
      if (this.mode === 'walk' && e.pointerType === 'touch'
          && e.clientX < innerWidth * 0.42 && this.stickId === null) {
        this.stickOrigin.set(e.clientX, e.clientY);
        this.stickId = e.pointerId;
        this.ui.showStick(e.clientX, e.clientY);
        return;
      }
      this.dragId = e.pointerId;
      this.dragging = true;
      this.touchAxis = 'none';
      this.lastPointer.set(e.clientX, e.clientY);
      this.dragOrigin.copy(this.lastPointer);
      this.dragDistance = 0;
    }, { signal });

    this.canvas.addEventListener('pointermove', (e: PointerEvent) => {
      this.pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.parallaxTarget.set(this.pointerNdc.x, this.pointerNdc.y);
      this.hoverTimer = 0;

      if (this.stickId === e.pointerId) {
        const dx = (e.clientX - this.stickOrigin.x) / 70;
        const dy = (e.clientY - this.stickOrigin.y) / 70;
        const len = Math.hypot(dx, dy);
        const k = len > 1 ? 1 / len : 1;
        this.walker.stick.set(dx * k, dy * k);
        this.ui.moveStick(dx * k, dy * k);
        return;
      }
      if (document.pointerLockElement === this.canvas || !this.dragging || this.dragId !== e.pointerId) return;
      this.dragDistance = Math.max(this.dragDistance, Math.hypot(e.clientX - this.dragOrigin.x, e.clientY - this.dragOrigin.y));
      if (this.dragDistance >= 6) this.markerHot = false;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer.set(e.clientX, e.clientY);

      if (this.mode === 'walk') {
        this.walker.look(dx, dy);
        return;
      }
      if (e.pointerType === 'touch') {
        // Vertical drag travels the route, horizontal drag turns the head.
        if (this.touchAxis === 'none') {
          if (this.dragDistance < 6) return;
          this.touchAxis = Math.abs(e.clientY - this.dragOrigin.y) > Math.abs(e.clientX - this.dragOrigin.x) ? 'route' : 'look';
        }
        if (this.touchAxis === 'route') { this.nudge(-dy * 0.0034); return; }
      }
      this.lookYaw = T.MathUtils.clamp(this.lookYaw - dx * 0.0022, -1.0, 1.0);
      this.lookPitch = T.MathUtils.clamp(this.lookPitch - dy * 0.0020, -0.5, 0.5);
      this.idle = 0;
    }, { signal });

    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.canvas.addEventListener(ev, (e: PointerEvent) => {
        if (this.stickId === e.pointerId) {
          this.stickId = null;
          this.walker?.stick.set(0, 0);
          this.ui.hideStick();
        }
        if (this.dragId === e.pointerId) {
          this.dragging = false;
          this.dragId = null;
        }
      }, { signal });
    }

    this.canvas.addEventListener('click', () => {
      if (this.mode === 'tour' && this.dragDistance < 6 && this.markerHot && this.marker.visible) {
        this.enterWalk(this.markerBl[0], this.markerBl[1]);
      }
    }, { signal });

    // Pointer lock while walking, exactly as the reference room does it: the
    // mouse turns the head with no edge to run into. Dragging still works when
    // the browser refuses the lock.
    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.mode === 'walk' && document.pointerLockElement === this.canvas) {
        this.walker.look(e.movementX, e.movementY);
      }
    }, { signal });
    document.addEventListener('pointerlockchange', () => {
      if (this.mode === 'walk' && document.pointerLockElement !== this.canvas) {
        this.leaveWalk();
      }
    }, { signal });
    document.addEventListener('pointerlockerror', () => {
      if (this.mode === 'walk') {
        this.ui.hint('<b>Przeciągnij</b>, aby się rozejrzeć · <b>WASD</b> ruch · <b>Esc</b> powrót', 7000);
      }
    }, { signal });

    addEventListener('pointerleave', () => this.parallaxTarget.set(0, 0), { signal });
    addEventListener('blur', () => this.resetInput(), { signal });
    document.addEventListener('visibilitychange', () => {
      this.resetInput();
      this.clock.getDelta();
      this.governor.reset();
      this.ambience.setPageVisible(!document.hidden);
    }, { signal });
  }

  private stickOrigin = new T.Vector2();
  private stickId: number | null = null;

  private nudge(delta: number) {
    this.targetP = T.MathUtils.clamp(this.targetP + delta, 0, STATIONS.length - 1);
    this.idle = 0;
    this.started = true;
    this.ui.hideCue();
  }

  private goTo(i: number) {
    if (this.mode === 'walk') this.leaveWalk();
    this.targetP = T.MathUtils.clamp(i, 0, STATIONS.length - 1);
    this.idle = 2;
    this.started = true;
    this.ui.hideCue();
  }

  // ------------------------------------------------------------------- walk
  private enterWalkHere() {
    // Start from wherever the camera already stands, if that is a real floor.
    const b: [number, number] = [this.camera.position.x, -this.camera.position.z];
    this.enterWalk(b[0], b[1]);
  }

  private enterWalk(bx: number, by: number) {
    if (this.mode === 'walk') return;
    const snapped = this.nav.snap(bx, by, 2.2);
    if (!snapped) {
      this.ui.hint('Tam nie da się stanąć', 2400);
      return;
    }
    const e = new T.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.resetInput();
    this.walker.placeAt(snapped[0], snapped[1], e.y, e.x);
    this.started = true;
    this.ui.hideCue();
    this.mode = 'walk';
    this.canvas.style.opacity = '1';
    this.marker.visible = false;
    document.body.classList.add('walking');
    this.ui.walkState(true);
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.ui.hint(
      coarse
        ? '<b>Lewa połowa</b> — ruch · <b>przeciągnij</b> — rozglądanie · <b>Trasa</b> — powrót'
        : '<b>WASD</b> ruch · <b>mysz</b> rozglądanie · <b>Shift</b> szybciej · <b>Esc</b> powrót',
      7000,
    );
    if (!coarse && innerWidth > 640) {
      // Refused in embedded documents and without a fresh gesture. Dragging to
      // look already covers that, but the newer API rejects a promise rather
      // than returning nothing, and an unhandled rejection is still a defect.
      Promise.resolve(this.canvas.requestPointerLock?.()).catch(() => {
        this.ui.hint(
          '<b>Przeciągnij</b> — rozglądanie · <b>WASD</b> ruch · <b>Esc</b> powrót',
          7000,
        );
      });
    }
  }

  private leaveWalk() {
    if (this.mode !== 'walk') return;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.resetInput();
    this.blendFrom.pos.copy(this.camera.position);
    this.blendFrom.quat.copy(this.camera.quaternion);
    this.blendFrom.fov = this.camera.fov;
    this.blendFrom.time = this.currentTime;
    this.targetP = this.route.nearest(this.camera.position, eye => this.clearView(eye));
    this.returnOccluded = !this.clearView(this.route.sample(this.targetP).eye);
    this.routeP = this.targetP;
    this.routeV = 0;
    this.blend = 0;
    this.mode = 'returning';
    document.body.classList.remove('walking');
    this.ui.walkState(false);
    this.ui.hideStick();
    this.ui.hint('');
  }

  // ------------------------------------------------------------- the camera
  private clearView(target: T.Vector3) {
    this.scratch.copy(target).sub(this.camera.position);
    const distance = this.scratch.length();
    if (distance < 0.1) return true;
    this.ray.set(this.camera.position, this.scratch.multiplyScalar(1 / distance));
    this.ray.far = distance;
    const clear = this.ray.intersectObjects(this.world.solids, false).length === 0;
    this.ray.far = Infinity;
    return clear;
  }

  private applyTourCamera(p: number) {
    const s = this.route.sample(p);
    const dir = this.scratch.copy(s.aim).sub(s.eye).normalize();
    const basePitch = Math.asin(T.MathUtils.clamp(dir.y, -1, 1));
    const baseYaw = Math.atan2(-dir.x, -dir.z);

    const t = this.clock.elapsedTime;
    // A camera on a real dolly is never perfectly still.
    const driftY = this.reduced ? 0 : Math.sin(t * 0.37) * 0.0026 + Math.sin(t * 0.91) * 0.0013;
    const driftX = this.reduced ? 0 : Math.cos(t * 0.29) * 0.0022 + Math.sin(t * 0.73) * 0.0011;

    this.camera.position.copy(s.eye);
    if (!this.reduced) {
      this.camera.position.y += Math.sin(t * 0.42) * 0.006;
      this.camera.position.x += Math.sin(t * 0.31) * 0.005;
    }
    this.camera.rotation.set(
      basePitch + this.lookPitch + this.parallax.y * 0.035 + driftY,
      baseYaw + this.lookYaw + this.parallax.x * -0.045 + driftX,
      s.roll,
      'YXZ',
    );
    this.setFov(this.fitFov(s.fov));
    return s;
  }

  private setFov(fov: number) {
    if (Math.abs(this.camera.fov - fov) < 0.001) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private resetInput() {
    this.walker?.clear();
    this.dragging = false;
    this.dragId = this.stickId = null;
    this.ui.hideStick();
    this.markerHot = false;
    this.markerFade = 0;
    this.marker.visible = false;
    document.body.style.cursor = '';
  }

  private applyWalkCamera() {
    this.walker.eye(this.camera.position);
    this.camera.rotation.set(this.walker.pitch, this.walker.yaw, 0, 'YXZ');
    this.setFov(this.fitFov(58));
  }

  /** Every station is framed for a wide screen. On a narrow one, hold the
   *  horizontal field and let the vertical open up, so a phone sees the same
   *  composition taller rather than a crop of its middle. */
  private fitFov(designFov: number) {
    const design = 16 / 9;
    const aspect = Math.max(this.camera.aspect, 0.35);
    if (aspect >= design) return designFov;
    const half = T.MathUtils.degToRad(designFov) / 2;
    const hHalf = Math.atan(Math.tan(half) * design);
    const v = 2 * Math.atan(Math.tan(hHalf) / aspect);
    // Past about 74 degrees the edges of a phone frame start to bulge.
    return Math.min(T.MathUtils.radToDeg(v), 74);
  }

  /** The floor marker: rest the cursor and the place you could stand quietly
   *  draws itself. It is the only way in and out that is not a keystroke. */
  private updateMarker(dt: number) {
    if (this.dragging) return;
    if (this.mode !== 'tour' || this.coarse) {
      this.marker.visible = false;
      return;
    }
    this.hoverTimer += dt;
    if (this.hoverTimer < 0.55 || this.pointerNdc.y < -1.5) {
      if (this.hoverTimer < 0.55) this.fadeMarker(dt, false);
      return;
    }
    // Same reason as the hotspots: pick at 10 Hz, not once a frame.
    this.markerClock += dt;
    if (this.markerClock < 0.1) {
      this.fadeMarker(dt, this.markerHot);
      return;
    }
    this.markerClock = 0;
    this.ray.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.ray.intersectObjects(this.world.solids, false);
    const hit = hits[0];
    if (hit && (hit.distance >= 14 || (hit.face?.normal.y ?? 0) <= 0.5)) { this.fadeMarker(dt, false); return; }
    if (!hit) {
      this.fadeMarker(dt, false);
      return;
    }
    const bx = hit.point.x;
    const by = -hit.point.z;
    const snapped = this.nav.snap(bx, by, 0.4);
    if (!snapped) {
      this.fadeMarker(dt, false);
      return;
    }
    this.markerBl = snapped;
    this.markerAt.set(snapped[0], this.nav.groundAt(snapped[0], snapped[1]) + 0.012, -snapped[1]);
    this.marker.position.lerp(this.markerAt, this.marker.visible ? 0.25 : 1);
    this.fadeMarker(dt, true);
  }

  private markerFade = 0;
  private markerClock = 0;
  private fadeMarker(dt: number, show: boolean) {
    this.markerFade = T.MathUtils.damp(this.markerFade, show ? 1 : 0, 9, dt);
    this.markerHot = this.markerFade > 0.5;
    this.marker.visible = this.markerFade > 0.02;
    this.marker.children.forEach((c, i) => {
      const m = (c as T.Mesh).material as T.MeshBasicMaterial;
      m.opacity = this.markerFade * (i === 0 ? 0.55 : 0.85);
    });
    const s = 0.85 + 0.15 * this.markerFade;
    this.marker.scale.setScalar(s);
    document.body.style.cursor = this.markerHot ? 'pointer' : '';
  }

  /** Occlusion for the hotspots.
   *
   *  BVH accelerates the merged architecture. Round-robin picking keeps the
   *  work bounded when several hotspots enter the view at once.
   */
  private occlusionCursor = 0;
  private updateOcclusion(walking: boolean) {
    const origin = this.camera.position;
    const target = this.scratch;
    for (let attempt = 0; attempt < HOTSPOTS.length; attempt++) {
      const i = this.occlusionCursor % HOTSPOTS.length;
      this.occlusionCursor++;
      const spot = HOTSPOTS[i];
      if (!walking && (this.routeP <= spot.from || this.routeP >= spot.to)) {
        this.hotspotVisible[i] = false;
        continue;
      }
      target.set(spot.at[0], spot.at[2], -spot.at[1]);
      const dist = origin.distanceTo(target);
      if (dist > 16) {
        this.hotspotVisible[i] = false;
        continue;
      }
      this.ray.set(origin, target.sub(origin).normalize());
      this.ray.far = dist - 0.3;
      this.hotspotVisible[i] = this.ray.intersectObjects(this.world.solids, false).length === 0;
      this.ray.far = Infinity;
      return;                              // one ray per tick, round robin
    }
  }

  // ------------------------------------------------------------------- loop
  private tick = (now: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    if (document.hidden || this.contextLost) return;
    this.renderer.info.reset();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    let time = STATIONS[0].time;
    let bias = STATIONS[0].bias ?? 0;

    if (this.mode === 'tour' || this.mode === 'returning') {
      this.idle += dt;
      // Gentle magnetism: stop scrolling and the route settles on a station,
      // so every resting frame is a composed one.
      if (this.idle > 0.45 && this.mode === 'tour') {
        const near = Math.round(this.targetP);
        this.targetP += (near - this.targetP) * (1 - Math.exp(-2.4 * dt));
      }
      const k = 26;
      const c = 2 * Math.sqrt(k) * 1.02;
      if (this.mode === 'tour') {
        this.routeV += (-k * (this.routeP - this.targetP) - c * this.routeV) * dt;
        this.routeP += this.routeV * dt;
      }

      // Free look drifts back to the route's framing once you let go.
      if (!this.dragging) {
        const back = 1 - Math.exp(-1.8 * dt);
        this.lookYaw -= this.lookYaw * back;
        this.lookPitch -= this.lookPitch * back;
      }
      this.parallax.lerp(this.parallaxTarget, 1 - Math.exp(-3.2 * dt));

      const s = this.applyTourCamera(this.routeP);
      time = s.time;
      bias = s.bias;
      this.ui.chapter(s.index);
      this.ui.route(this.routeP);

      if (this.mode === 'returning') {
        this.blend = Math.min(1, this.blend + dt / 1.35);
        const e = this.blend < 0.5 ? 2 * this.blend * this.blend : 1 - (-2 * this.blend + 2) ** 2 / 2;
        const target = this.scratch.copy(this.camera.position);
        const targetQ = this.targetQuat.copy(this.camera.quaternion);
        const targetFov = this.camera.fov;
        this.camera.position.lerpVectors(this.blendFrom.pos, target, e);
        if (this.returnOccluded) {
          this.canvas.style.opacity = String(Math.abs(2 * e - 1));
          this.camera.position.copy(e < 0.5 ? this.blendFrom.pos : target);
        }
        this.camera.quaternion.slerpQuaternions(this.blendFrom.quat, targetQ, e);
        this.camera.fov = T.MathUtils.lerp(this.blendFrom.fov, targetFov, e);
        this.camera.updateProjectionMatrix();
        time = T.MathUtils.lerp(this.blendFrom.time, s.time, e);
        if (this.blend >= 1) { this.mode = 'tour'; this.canvas.style.opacity = '1'; }
      }
    } else {
      this.walker.update(dt);
      this.applyWalkCamera();
      const s = this.route.sample(this.routeP);
      time = s.time;
      bias = s.bias;
      this.marker.visible = false;
    }

    // Every tier needs the environment map: without it the materials are lit
    // by nothing but the sun and read as plastic. The cheap tier just bakes
    // it a good deal less often.
    this.currentTime = time;
    this.sky.apply(time, this.scene, !this.noEnv,
                   this.settings.tier === 'low' ? 800 : 190);
    this.renderer.toneMappingExposure = this.sky.exposure * (1 + bias);
    this.world.update(elapsed, this.sky.practical, this.reduced ? 0.35 : 1);
    this.ambience.update(dt);
    if (this.grain) this.grain.uniforms.uTime.value = elapsed;

    this.camera.updateMatrixWorld();
    this.updateMarker(dt);
    this.occlusionClock += dt;
    if (this.occlusionClock > 0.09) {
      this.occlusionClock = 0;
      this.updateOcclusion(this.mode === 'walk');
    }
    this.ui.placeHotspots(this.camera, this.routeP, this.mode === 'walk', (i) => this.hotspotVisible[i]);

    this.shadowClock += dt;
    if (this.settings.shadows && this.shadowClock > 0.125) {
      this.shadowClock = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);

    const dpr = this.governor.tick(now);
    if (dpr !== null) {
      this.renderer.setPixelRatio(dpr);
      this.composer?.setPixelRatio(dpr);
      this.resize();
    }
    if (this.showStats && now - this.statsAt > 250) {
      this.statsAt = now;
      const info = this.renderer.info.render;
      this.ui.stats(
        `${Math.round(this.governor.fps) || '--'} fps\n` +
        `${info.calls} calls\n` +
        `${(info.triangles / 1000).toFixed(0)}k tris\n` +
        `dpr ${this.governor.dpr.toFixed(2)}\n` +
        `${this.settings.tier}${this.settings.ao ? ' ao' : ''}${this.settings.shadows ? ' sh' : ''}\n` +
        `x ${this.camera.position.x.toFixed(2)} y ${(-this.camera.position.z).toFixed(2)}`,
      );
    }
  };

  private resize() {
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    document.body.classList.toggle('portrait', h > w * 1.15);
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);

  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.abort.dispose();
    this.resetInput();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.ui.dispose();
    this.disposeComposer();
    this.composer = null;
    this.scene.environment = null;
    this.ambience.dispose();
    this.world.dispose();
    this.sky.dispose();
    this.marker.traverse((o) => {
      const m = o as T.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as T.Material).dispose();
      }
    });
    this.scene.clear();
    this.renderer.dispose();
  }
}
