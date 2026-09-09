import * as T from 'three';
import { Lifetime } from './lifetime';
import { HOTSPOTS, STATIONS } from './tour';

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

export class Ui {
  private lifetime = new Lifetime();
  private projected = new T.Vector3();
  private routeHeight = '';
  private veil = $('veil');
  private veilFill = $('veilFill');
  private veilPct = $('veilPct');
  private chIndex = $('chIndex');
  private chName = $('chName');
  private chLine = $('chLine');
  private thread = $('thread');
  private cue = $('cue');
  private hintEl = $('hint');
  private statsEl = $('stats');
  private ring = $('ring');
  private btnWalk = $<HTMLButtonElement>('btnWalk');
  private btnSound = $<HTMLButtonElement>('btnSound');
  private stick = $('stick');
  private spotHost = $('hotspots');
  private ticks: HTMLElement[] = [];
  private fill!: HTMLElement;
  private spots: { el: HTMLElement; index: number }[] = [];
  private shownChapter = -1;
  private hintTimer = 0;
  private cueHidden = false;

  onStation: (i: number) => void = () => {};
  onWalkToggle: () => void = () => {};
  onSoundToggle: () => void = () => {};

  constructor() {
    const signal = this.lifetime.signal;
    const rail = document.createElement('div');
    rail.className = 'rail';
    this.thread.append(rail);
    this.fill = document.createElement('div');
    this.fill.className = 'fill';
    this.thread.append(this.fill);

    STATIONS.forEach((s, i) => {
      const tick = document.createElement('button');
      tick.className = 'tick';
      tick.style.top = `${(i / (STATIONS.length - 1)) * 100}%`;
      tick.type = 'button';
      tick.setAttribute('aria-label', `${i + 1}. ${s.name}`);
      tick.addEventListener('click', () => this.onStation(i), { signal });
      this.thread.append(tick);
      this.ticks.push(tick);
    });

    HOTSPOTS.forEach((h, i) => {
      const el = document.createElement('button');
      el.className = 'spot';
      el.type = 'button';
      el.setAttribute('aria-label', h.tag);
      el.innerHTML =
        '<span class="halo"></span><span class="pulse"></span><span class="dot"></span>' +
        '<span class="lead"></span><span class="tag"></span>';
      (el.querySelector('.tag') as HTMLElement).textContent = h.tag;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onStation(h.station);
      }, { signal });
      el.addEventListener('pointerenter', () => this.ring.classList.add('hot'), { signal });
      el.addEventListener('pointerleave', () => this.ring.classList.remove('hot'), { signal });
      this.spotHost.append(el);
      this.spots.push({ el, index: i });
    });

    this.btnWalk.addEventListener('click', () => this.onWalkToggle(), { signal });
    this.btnSound.addEventListener('click', () => this.onSoundToggle(), { signal });
    for (const b of [this.btnWalk, this.btnSound]) {
      b.addEventListener('pointerenter', () => this.ring.classList.add('hot'), { signal });
      b.addEventListener('pointerleave', () => this.ring.classList.remove('hot'), { signal });
    }

    if (matchMedia('(pointer: coarse)').matches) {
      (this.cue.querySelector('span') as HTMLElement).textContent = 'przesuń';
    }

    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      document.body.classList.add('fine-pointer');
      addEventListener('pointermove', (e) => {
        this.ring.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      }, { passive: true, signal });
    }
  }

  dispose() {
    this.lifetime.dispose();
    this.lifetime.cancel(this.hintTimer);
    this.thread.replaceChildren();
    this.spotHost.replaceChildren();
    this.onStation = this.onWalkToggle = this.onSoundToggle = () => {};
    document.body.classList.remove('walking', 'fine-pointer');
  }

  progress(f: number) {
    this.veilFill.style.width = `${Math.round(f * 100)}%`;
    this.veilPct.textContent = String(Math.round(f * 100)).padStart(2, '0');
  }

  reveal() {
    this.veil.classList.add('lift');
    document.body.classList.add('ready');
    this.lifetime.later(() => this.veil.hidden = true, 1800);
  }

  fail(message: string) {
    const box = $('fallback');
    $('fallbackText').textContent = message;
    box.hidden = false;
    this.veil.classList.add('lift');
  }

  /** Chapter titles are wiped in from below, like a title card. */
  chapter(i: number) {
    if (i === this.shownChapter) return;
    this.shownChapter = i;
    const s = STATIONS[i];
    this.chIndex.textContent = String(i + 1).padStart(2, '0');
    for (const [el, text, delay] of [
      [this.chName, s.name, 0],
      [this.chLine, s.line, 90],
    ] as [HTMLElement, string, number][]) {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.setProperty('--rise', '0.6em');
      span.style.setProperty('--fade', '0');
      el.replaceChildren(span);
      this.lifetime.later(() => {
          span.style.setProperty('--rise', '0');
          span.style.setProperty('--fade', '1');
        }, delay + 16);
    }
    this.ticks.forEach((t, k) => {
      t.classList.toggle('on', k === i);
      if (k === i) t.setAttribute('aria-current', 'step');
      else t.removeAttribute('aria-current');
    });
  }

  route(p: number) {
    const f = p / (STATIONS.length - 1);
    const height = `${(Math.min(1, Math.max(0, f)) * 100).toFixed(2)}%`;
    if (height !== this.routeHeight) this.fill.style.height = this.routeHeight = height;
  }

  hideCue() {
    if (this.cueHidden) return;
    this.cueHidden = true;
    this.cue.classList.add('gone');
  }

  hint(html: string, ms = 5200) {
    this.lifetime.cancel(this.hintTimer);
    if (!html) {
      this.hintEl.classList.remove('on');
      return;
    }
    this.hintEl.innerHTML = html;
    this.hintEl.classList.add('on');
    if (ms > 0) {
      this.hintTimer = this.lifetime.later(() => this.hintEl.classList.remove('on'), ms);
    }
  }

  walkState(walking: boolean) {
    this.btnWalk.classList.toggle('on', walking);
    this.btnWalk.setAttribute('aria-pressed', String(walking));
    (this.btnWalk.querySelector('span') as HTMLElement).textContent =
      walking ? 'Trasa' : 'Spacer';
    this.btnWalk.setAttribute(
      'aria-label',
      walking ? 'Wróć na zaprojektowaną trasę' : 'Chodź swobodnie po mieszkaniu i ogrodzie',
    );
  }

  soundState(on: boolean) {
    this.btnSound.classList.toggle('on', on);
    this.btnSound.setAttribute('aria-pressed', String(on));
  }

  showStick(x: number, y: number) {
    this.stick.style.transform = `translate(${x}px, ${y}px)`;
    this.stick.classList.add('on');
  }

  moveStick(dx: number, dy: number) {
    (this.stick.firstElementChild as HTMLElement).style.transform =
      `translate(${dx * 30}px, ${dy * 30}px)`;
  }

  hideStick() {
    this.stick.classList.remove('on');
    (this.stick.firstElementChild as HTMLElement).style.transform = '';
  }

  stats(text: string | null) {
    this.statsEl.hidden = text === null;
    if (text !== null) this.statsEl.textContent = text;
  }

  /** Project the hotspots and decide which of them are worth offering. */
  placeHotspots(
    camera: T.PerspectiveCamera,
    routeP: number,
    walking: boolean,
    visible: (i: number) => boolean,
  ) {
    const v = this.projected;
    const w = innerWidth;
    const h = innerHeight;
    for (const { el, index } of this.spots) {
      const spot = HOTSPOTS[index];
      const inRange = walking || (routeP > spot.from && routeP < spot.to);
      if (!inRange || !visible(index)) {
        el.classList.remove('vis');
        el.tabIndex = -1;
        el.setAttribute('aria-hidden', 'true');
        continue;
      }
      v.set(spot.at[0], spot.at[2], -spot.at[1]).project(camera);
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 0.94 || Math.abs(v.y) > 0.9) {
        el.classList.remove('vis');
        el.tabIndex = -1;
        el.setAttribute('aria-hidden', 'true');
        continue;
      }
      el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
      // Fade the marker out towards the edge of frame instead of popping it.
      const edge = Math.max(Math.abs(v.x) / 0.94, Math.abs(v.y) / 0.9);
      el.style.setProperty('--vis', String(Math.min(1, (1 - edge) * 4.5)));
      el.classList.add('vis');
      el.tabIndex = 0;
      el.removeAttribute('aria-hidden');
    }
  }
}
