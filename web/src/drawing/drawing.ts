import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Connection, Guide, Side, Visual } from '../../../shared/types';
import { easeGlide, easeInOut, paper } from './look';
import { PartModel } from './part';
import { Wire } from './wire';

// The assembly drawing: parts on a table seen from an isometric angle, built up step by
// step. Earlier steps stay drawn; the current step's wires draw themselves in, in red
// pen. Callouts (numbered balloons and pin labels) are html laid over the canvas.

const GAP = 26;
const VIEW = 160; // mm of table visible top to bottom at zoom 1

type Callout = { key: string; x: number; y: number; ax: number; ay: number; text: string; kind: 'part' | 'pin' };

export class Drawing {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  private readonly controls: OrbitControls;
  private readonly overlay: HTMLElement;
  private guide: Guide | null = null;
  private models = new Map<string, PartModel>();
  private wires: { wire: Wire; current: boolean }[] = [];
  private appear = new Map<string, number>(); // part id -> when it started appearing
  private visible = new Set<string>();
  private flight: { from: THREE.Vector3; to: THREE.Vector3; fromZoom: number; toZoom: number; start: number } | null = null;
  private step = -1;
  private lastFocus: { targets: string[]; connections: Connection[] } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly reduceMotion: boolean,
    /** how many pixels on the right are covered (by the step panel), so framing avoids them */
    private readonly covered: () => number = () => 0,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(paper, 0);
    host.append(this.renderer.domElement);
    this.overlay = document.createElement('div');
    this.overlay.className = 'callouts';
    host.append(this.overlay);

    // isometric: looking down at 35° from the front-left corner
    this.camera.position.set(-1, 0.85, 1).normalize().multiplyScalar(600);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.minZoom = 0.3;
    this.controls.maxZoom = 12;

    // the table: a faint 10 mm grid, like squared drawing paper
    const grid = new THREE.GridHelper(2000, 200, '#d9d6cc', '#e6e3db');
    grid.position.y = -0.02;
    this.scene.add(grid);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setGuide(guide: Guide) {
    for (const model of this.models.values()) this.scene.remove(model.group);
    for (const { wire } of this.wires) {
      this.scene.remove(wire.group);
      wire.dispose();
    }
    this.models.clear();
    this.wires = [];
    this.visible.clear();
    this.appear.clear();
    this.guide = guide;
    this.step = -1;

    // parts sit in a row, each turned so its pins face the part they connect to
    const ordered = this.order(guide);
    const connections = guide.steps.flatMap((s) => s.connections);
    let x = 0;
    ordered.forEach((part, i) => {
      const model = new PartModel(part);
      const partners = connections.flatMap((c) =>
        c.from.part === part.id ? [{ pin: c.from.pin, other: c.to.part }] : c.to.part === part.id ? [{ pin: c.to.pin, other: c.from.part }] : [],
      );
      const left = partners.filter((p) => ordered.findIndex((o) => o.id === p.other) < i);
      const right = partners.filter((p) => ordered.findIndex((o) => o.id === p.other) > i);
      // face whichever neighbour it has wires to; a part wired both ways keeps its own way round
      const towards = left.length && !right.length ? -1 : right.length && !left.length ? 1 : 0;
      const pins = (towards < 0 ? left : right).map((p) => part.pins.find((pin) => pin.id === p.pin)?.side);
      const side = mostCommon(pins.filter((s) => !!s));
      model.group.rotation.y = towards && side ? turn(side, towards) : 0;
      const footprint = Math.abs(Math.cos(model.group.rotation.y)) * part.size.w + Math.abs(Math.sin(model.group.rotation.y)) * part.size.h;
      model.group.position.set(x + footprint / 2, 0, 0);
      x += footprint + GAP;
      model.setOpacity(0);
      this.models.set(part.id, model);
      this.scene.add(model.group);
    });
    // centre the row on the origin
    const shift = (x - GAP) / 2;
    for (const model of this.models.values()) model.group.position.x -= shift;
  }

  /** shows a step: every part and wire up to it, with this step's wires drawn in */
  setStep(index: number, animate = true) {
    if (!this.guide) return;
    const steps = this.guide.steps;
    index = Math.max(0, Math.min(steps.length - 1, index));
    const going = animate && !this.reduceMotion;
    const now = performance.now();

    const shown = new Set<string>();
    for (const step of steps.slice(0, index + 1)) {
      step.show.forEach((id) => shown.add(id));
      for (const c of step.connections) shown.add(c.from.part).add(c.to.part);
    }
    for (const [id, model] of this.models) {
      if (shown.has(id) && !this.visible.has(id)) this.appear.set(id, going ? now : 0);
      if (!shown.has(id)) model.setOpacity(0);
    }
    this.visible = shown;

    this.clearWires();
    steps.slice(0, index).forEach((step) => step.connections.forEach((c) => this.addWire(c, false, -1)));
    steps[index].connections.forEach((c, i) => this.addWire(c, true, going ? 250 + i * 160 : -1));

    this.focus(steps[index].focus, steps[index].connections, going);
    this.step = index;
  }

  /** what the guide agent wants to show alongside an answer */
  showVisual(visual: Visual) {
    if (!this.guide) return;
    if (visual.step !== null && visual.step !== this.step) this.setStep(visual.step);
    for (const c of visual.connections) this.addWire(c, true, this.reduceMotion ? -1 : 200);
    this.focus(visual.focus, visual.connections, !this.reduceMotion);
  }

  private order(guide: Guide) {
    // parts that connect sit next to each other: walk the connections from the first part
    const links = new Map<string, Set<string>>();
    for (const c of guide.steps.flatMap((s) => s.connections)) {
      links.set(c.from.part, (links.get(c.from.part) ?? new Set()).add(c.to.part));
      links.set(c.to.part, (links.get(c.to.part) ?? new Set()).add(c.from.part));
    }
    const ordered: string[] = [];
    for (const part of guide.parts) {
      if (ordered.includes(part.id)) continue;
      const queue = [part.id];
      while (queue.length) {
        const id = queue.shift()!;
        if (ordered.includes(id)) continue;
        ordered.push(id);
        queue.push(...(links.get(id) ?? []));
      }
    }
    return ordered.map((id) => guide.parts.find((p) => p.id === id)).filter((p) => !!p);
  }

  private pinWorld(end: { part: string; pin: string }) {
    const model = this.models.get(end.part);
    if (!model) return null;
    return world(model, model.anchor(end.pin));
  }

  private addWire(c: Connection, current: boolean, delay: number) {
    const a = this.pinWorld(c.from);
    const b = this.pinWorld(c.to);
    if (!a || !b) return;
    const wire = new Wire(a, b, c.wire);
    if (delay < 0) wire.place();
    else wire.animate(delay);
    wire.emphasise(current);
    this.wires.push({ wire, current });
    this.scene.add(wire.group);
  }

  private clearWires() {
    for (const { wire } of this.wires) {
      this.scene.remove(wire.group);
      wire.dispose();
    }
    this.wires = [];
  }

  /** red pen on the parts or pins that matter, and the camera moved to frame them */
  private focus(targets: string[], connections: Connection[], animate: boolean) {
    this.lastFocus = { targets, connections };
    const pins = new Map<string, string[]>();
    const whole = new Set<string>();
    for (const target of targets) {
      const dot = target.indexOf('.');
      if (dot < 0) whole.add(target);
      else pins.set(target.slice(0, dot), [...(pins.get(target.slice(0, dot)) ?? []), target.slice(dot + 1)]);
    }
    for (const c of connections) {
      pins.set(c.from.part, [...(pins.get(c.from.part) ?? []), c.from.pin]);
      pins.set(c.to.part, [...(pins.get(c.to.part) ?? []), c.to.pin]);
    }
    for (const [id, model] of this.models) {
      model.highlight(whole.has(id) || pins.has(id), whole.has(id) ? [] : (pins.get(id) ?? []));
    }

    // frame what's in focus, or everything that's showing
    const box = new THREE.Box3();
    const framed = [...whole, ...pins.keys()].filter((id) => this.visible.has(id));
    for (const id of framed.length ? framed : this.visible) {
      const model = this.models.get(id);
      if (model) box.expandByObject(model.group);
    }
    for (const { wire, current } of this.wires) if (current) box.expandByObject(wire.group);
    if (box.isEmpty()) return;
    this.flyTo(box, animate);
  }

  private flyTo(box: THREE.Box3, animate: boolean) {
    const centre = box.getCenter(new THREE.Vector3());
    // measure the box as the camera sees it, to find the zoom that fits it with a margin
    const view = this.camera.matrixWorldInverse.clone();
    const offset = new THREE.Matrix4().makeTranslation(this.controls.target.clone().sub(centre));
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
        .applyMatrix4(offset)
        .applyMatrix4(view),
    );
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const free = Math.max(0.35, 1 - this.covered() / Math.max(1, this.host.clientWidth));
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    const zoom = Math.min((VIEW * aspect * free) / Math.max(width, 1), VIEW / Math.max(height, 1)) * 0.78;
    const toZoom = THREE.MathUtils.clamp(zoom, this.controls.minZoom, this.controls.maxZoom);
    if (!animate) {
      this.moveTo(centre, toZoom);
      return;
    }
    this.flight = { from: this.controls.target.clone(), to: centre, fromZoom: this.camera.zoom, toZoom, start: performance.now() };
  }

  private moveTo(target: THREE.Vector3, zoom: number) {
    const shift = target.clone().sub(this.controls.target);
    this.controls.target.copy(target);
    this.camera.position.add(shift);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    this.camera.left = (-VIEW * aspect) / 2;
    this.camera.right = (VIEW * aspect) / 2;
    this.camera.top = VIEW / 2;
    this.camera.bottom = -VIEW / 2;
    // centre the drawing in the part of the sheet the step panel doesn't cover
    this.camera.setViewOffset(w, h, this.covered() / 2, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** call when the covered area changes size: the camera re-frames what it was showing */
  refit() {
    this.resize();
    if (this.lastFocus && !this.flight) this.focus(this.lastFocus.targets, this.lastFocus.connections, false);
  }

  private frame() {
    const now = performance.now();
    if (this.flight) {
      const f = this.flight;
      const t = (now - f.start) / 700;
      const k = easeInOut(t);
      this.moveTo(f.from.clone().lerp(f.to, k), THREE.MathUtils.lerp(f.fromZoom, f.toZoom, k));
      if (t >= 1) this.flight = null;
    }
    this.controls.enabled = !this.flight;
    this.controls.update();

    // parts settle into place: fading in while dropping the last few millimetres
    for (const [id, started] of this.appear) {
      const model = this.models.get(id)!;
      const t = started ? (now - started) / 600 : 1;
      model.setOpacity(Math.min(1, t * 1.25));
      model.group.position.y = (1 - easeGlide(t)) * 8;
      if (t >= 1) this.appear.delete(id);
    }
    for (const { wire } of this.wires) wire.tick(now);

    this.renderer.render(this.scene, this.camera);
    this.drawCallouts();
  }

  private drawCallouts() {
    if (!this.guide) return;
    const callouts: Callout[] = [];
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const project = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
    };

    this.guide.parts.forEach((part, i) => {
      const model = this.models.get(part.id);
      if (!model || !this.visible.has(part.id)) return;
      // a numbered balloon off the part's far-right corner (pins are usually elsewhere),
      // matching the parts list
      const corner = world(model, new THREE.Vector3(part.size.w / 2, part.size.t, -part.size.h / 2));
      const at = project(corner);
      callouts.push({ key: `part-${part.id}`, x: at.x + 22, y: at.y - 30, ax: at.x, ay: at.y, text: String(i + 1), kind: 'part' });
    });

    // labels for the pins being wired right now
    const current = this.guide.steps[this.step];
    const ends = (current?.connections ?? []).flatMap((c) => [c.from, c.to]);
    for (const target of current?.focus ?? []) {
      const dot = target.indexOf('.');
      if (dot > 0) ends.push({ part: target.slice(0, dot), pin: target.slice(dot + 1) });
    }
    // pins sit close together, so their labels fan out in a tidy row away from the board,
    // in the same order as the pins, each with a leader line back to its pin
    const groups = new Map<string, { key: string; label: string; at: { x: number; y: number }; centre: { x: number; y: number } }[]>();
    const seen = new Set<string>();
    for (const end of ends) {
      const key = `${end.part}.${end.pin}`;
      const model = this.models.get(end.part);
      if (seen.has(key) || !model) continue;
      seen.add(key);
      const pin = model.part.pins.find((p) => p.id === end.pin);
      const group = `${end.part}:${pin?.side ?? 'top'}`;
      groups.set(group, [
        ...(groups.get(group) ?? []),
        {
          key,
          label: pin?.label ?? end.pin,
          at: project(world(model, model.anchor(end.pin))),
          centre: project(model.group.position.clone().setY(model.part.size.t)),
        },
      ]);
    }
    for (const pins of groups.values()) {
      const mid = { x: pins.reduce((s, p) => s + p.at.x, 0) / pins.length, y: pins.reduce((s, p) => s + p.at.y, 0) / pins.length };
      let dx = mid.x - pins[0].centre.x;
      let dy = mid.y - pins[0].centre.y;
      const length = Math.hypot(dx, dy) || 1;
      [dx, dy] = length < 4 ? [0, -1] : [dx / length, dy / length];
      const [px, py] = [-dy, dx];
      const spacing = Math.abs(px) > 0.7 ? 54 : 26;
      pins.sort((a, b) => (a.at.x - mid.x) * px + (a.at.y - mid.y) * py - ((b.at.x - mid.x) * px + (b.at.y - mid.y) * py));
      pins.forEach((pin, i) => {
        const along = (i - (pins.length - 1) / 2) * spacing;
        callouts.push({
          key: `pin-${pin.key}`,
          x: mid.x + dx * 64 + px * along,
          y: mid.y + dy * 64 + py * along,
          ax: pin.at.x,
          ay: pin.at.y,
          text: pin.label,
          kind: 'pin',
        });
      });
    }
    separate(callouts.filter((c) => c.kind === 'pin'));
    renderCallouts(this.overlay, callouts);
  }
}

/** nudges pin labels apart vertically until none overlap */
function separate(labels: Callout[]) {
  const W = 54;
  const H = 24;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    labels.sort((a, b) => a.y - b.y);
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i];
        const b = labels[j];
        if (Math.abs(a.x - b.x) >= W || b.y - a.y >= H) continue;
        const push = (H - (b.y - a.y)) / 2 + 0.5;
        a.y -= push;
        b.y += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** a point on a part, from its own coordinates to the table's (where it sits, how it's turned) */
function world(model: PartModel, local: THREE.Vector3) {
  return local.clone().applyEuler(model.group.rotation).add(new THREE.Vector3(model.group.position.x, 0, model.group.position.z));
}

const direction: Record<Side, [number, number]> = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] };

/** the turn about the vertical axis that points a side of a part along +x (1) or -x (-1) */
function turn(side: Side, towards: number) {
  const [x, z] = direction[side];
  // rotating by a about y sends (x, z) to (x cos a + z sin a, -x sin a + z cos a)
  return [0, Math.PI / 2, Math.PI, -Math.PI / 2].reduce((best, a) =>
    (x * Math.cos(a) + z * Math.sin(a)) * towards > (x * Math.cos(best) + z * Math.sin(best)) * towards ? a : best,
  );
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function renderCallouts(layer: HTMLElement, callouts: Callout[]) {
  let svg = layer.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    layer.append(svg);
  }
  const keep = new Set(callouts.map((c) => c.key));
  for (const el of [...layer.querySelectorAll<HTMLElement>('[data-key]')]) {
    if (!keep.has(el.dataset.key!)) el.remove();
  }
  let lines = '';
  for (const c of callouts) {
    let el = layer.querySelector<HTMLElement>(`[data-key="${CSS.escape(c.key)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.key = c.key;
      el.className = c.kind === 'part' ? 'balloon' : 'pin-callout';
      layer.append(el);
    }
    if (el.textContent !== c.text) el.textContent = c.text;
    el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) translate(-50%, -50%)`;
    lines += `<line x1="${c.x.toFixed(1)}" y1="${c.y.toFixed(1)}" x2="${c.ax.toFixed(1)}" y2="${c.ay.toFixed(1)}" class="${c.kind}" />`;
    if (c.kind === 'pin') lines += `<circle cx="${c.ax.toFixed(1)}" cy="${c.ay.toFixed(1)}" r="2" class="pin" />`;
  }
  svg.innerHTML = lines;
}
