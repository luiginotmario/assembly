import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Approach, Connection, Guide, Side, Vec3, View, Visual } from '../../../shared/types';
import { easeGlide, easeInOut, lights, paper } from './look';
import { loadAll } from './mesh';
import { PartModel } from './part';
import { Wire } from './wire';

// The assembly drawing, like the pages of a LEGO manual: parts in their real shapes and
// colours, built up step by step. Parts with a pose sit where they belong in the build (in its
// own z-up frame); boards that are only wired lie on the table beside it. Each step's parts
// slide in from where the hand brings them, its wires draw themselves in, and the camera turns
// when a step happens on the other side. Callouts (numbered balloons and pin labels) are html
// laid over the canvas.

const GAP = 26;
const VIEW = 160; // mm of table visible top to bottom at zoom 1
const DISTANCE = 600; // how far the camera sits from what it looks at

export type Insets = { top: number; bottom: number; left: number; right: number };

type Callout = { key: string; x: number; y: number; ax: number; ay: number; text: string; kind: 'part' | 'pin' };

/** where the camera looks from, in the table's y-up frame (front is toward the viewer) */
const VIEWS: Record<View, THREE.Vector3> = {
  iso: new THREE.Vector3(-1, 0.85, 1),
  'iso-back': new THREE.Vector3(1, 0.85, -1),
  front: new THREE.Vector3(0, 0.3, 1),
  back: new THREE.Vector3(0, 0.3, -1),
  left: new THREE.Vector3(-1, 0.3, 0),
  right: new THREE.Vector3(1, 0.3, 0),
  top: new THREE.Vector3(0, 1, 0.02),
  bottom: new THREE.Vector3(0, -1, 0.02),
};

/** the direction a part comes in from, in the build's z-up frame */
const APPROACH: Record<Approach, Vec3> = { above: [0, 0, 1], below: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };

type Arrival = { start: number; from: THREE.Vector3; duration: number };

export class Drawing {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -4000, 4000);
  private readonly controls: OrbitControls;
  private readonly overlay: HTMLElement;
  /** the build itself, in its own z-up frame (like CAD), turned so z points up the screen */
  private readonly assembly = new THREE.Group();
  private guide: Guide | null = null;
  private models = new Map<string, PartModel>();
  private wires: { wire: Wire; current: boolean }[] = [];
  private arriving = new Map<string, Arrival>();
  private visible = new Set<string>();
  private flight: { from: THREE.Vector3; to: THREE.Vector3; fromZoom: number; toZoom: number; fromDir: THREE.Vector3; toDir: THREE.Vector3; start: number } | null = null;
  private step = -1;
  /** the step each part is built in (placed or shown), and the first step it's used at all */
  private builtAt = new Map<string, number>();
  private lastFocus: { targets: string[]; connections: Connection[] } | null = null;
  private dir = VIEWS.iso.clone().normalize();

  constructor(
    private readonly host: HTMLElement,
    private readonly reduceMotion: boolean,
    /** how many pixels the page's floating cards cover on each side, so framing avoids them */
    private readonly covered: () => Insets = () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(paper, 0);
    host.append(this.renderer.domElement);
    this.overlay = document.createElement('div');
    this.overlay.className = 'callouts';
    host.append(this.overlay);

    // isometric: looking down at 35° from the front-left corner
    this.camera.position.copy(this.dir).multiplyScalar(DISTANCE);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minZoom = 0.15;
    this.controls.maxZoom = 12;
    lights(this.scene, this.camera);

    // the table: a faint 10 mm grid
    const grid = new THREE.GridHelper(4000, 400, '#e6e6eb', '#efeff3');
    grid.position.y = -0.02;
    this.scene.add(grid);
    this.assembly.rotation.x = -Math.PI / 2;
    this.scene.add(this.assembly);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** downloads the guide's 3d models before it's drawn */
  prepare(guide: Guide, progress: (done: number, total: number) => void) {
    return loadAll(guide.parts.flatMap((p) => (p.mesh ? [p.mesh] : [])), progress);
  }

  setGuide(guide: Guide) {
    for (const model of this.models.values()) model.group.removeFromParent();
    this.clearWires();
    this.models.clear();
    this.visible.clear();
    this.arriving.clear();
    this.guide = guide;
    this.step = -1;

    // the build: every posed part where it belongs, resting on the table
    const posed = guide.parts.filter((p) => p.pose);
    for (const part of posed) {
      const model = new PartModel(part);
      const [x, y, z] = part.pose!.at;
      const [rx, ry, rz] = part.pose!.turn.map(THREE.MathUtils.degToRad);
      model.rest.set(x, y, z);
      model.group.position.copy(model.rest);
      model.group.rotation.set(rx, ry, rz, 'XYZ');
      this.assembly.add(model.group);
      this.models.set(part.id, model);
    }
    this.assembly.position.set(0, 0, 0);
    this.assembly.updateMatrixWorld(true);
    const built = new THREE.Box3();
    for (const id of posed.map((p) => p.id)) built.expandByObject(this.models.get(id)!.group);
    if (!built.isEmpty()) {
      const centre = built.getCenter(new THREE.Vector3());
      this.assembly.position.set(-centre.x, -built.min.y, -centre.z);
    }

    // parts that are only wired lie in a row beside it, each turned so its pins face the part
    // they connect to
    const ordered = this.order(guide).filter((p) => !p.pose);
    const connections = guide.steps.flatMap((s) => s.connections);
    let x = built.isEmpty() ? 0 : (built.max.x - built.min.x) / 2 + GAP * 2;
    const start = x;
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
      const { w, h } = model.footprint();
      const footprint = Math.abs(Math.cos(model.group.rotation.y)) * w + Math.abs(Math.sin(model.group.rotation.y)) * h;
      model.rest.set(x + footprint / 2, 0, 0);
      x += footprint + GAP;
      this.models.set(part.id, model);
      this.scene.add(model.group);
    });
    // with nothing built, the row is centred on the origin
    if (built.isEmpty()) for (const id of ordered.map((p) => p.id)) this.models.get(id)!.rest.x -= (x - GAP - start) / 2;
    // a part of the build that's used before it's built in (a servo set up on the bench first)
    // waits loose on the table in front of the build, then travels into place
    this.builtAt.clear();
    const usedAt = new Map<string, number>();
    const placedAt = new Map<string, number>();
    guide.steps.forEach((step, i) => {
      for (const p of step.place ?? []) if (!placedAt.has(p.part)) placedAt.set(p.part, i);
      const used = [...step.show, ...(step.place ?? []).map((p) => p.part), ...step.connections.flatMap((c) => [c.from.part, c.to.part]), ...step.focus.map((f) => f.split('.')[0])];
      for (const id of used) if (!usedAt.has(id)) usedAt.set(id, i);
    });
    // built in at the step that slides it into place, or else the first one it appears in
    for (const [id, at] of usedAt) this.builtAt.set(id, placedAt.get(id) ?? at);
    this.assembly.updateMatrixWorld(true);
    const front = new THREE.Box3();
    for (const part of posed) front.expandByObject(this.models.get(part.id)!.group);
    let along = front.isEmpty() ? 0 : front.min.x;
    for (const part of posed) {
      const model = this.models.get(part.id)!;
      if ((usedAt.get(part.id) ?? Infinity) >= (this.builtAt.get(part.id) ?? Infinity)) continue;
      const box = new THREE.Box3().setFromObject(model.group);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const goal = new THREE.Vector3(along + size.x / 2, size.y / 2, front.max.z + GAP * 2 + size.z / 2);
      along += size.x + GAP;
      const home = this.assembly.localToWorld(model.rest.clone()).add(goal.sub(centre));
      model.loose = this.assembly.worldToLocal(home);
    }
    for (const model of this.models.values()) {
      model.target.copy(model.rest);
      model.group.position.copy(model.rest);
      model.setOpacity(0);
    }
  }

  /** shows a step: every part and wire up to it, with this step's parts sliding in and its wires drawn in */
  setStep(index: number, animate = true) {
    if (!this.guide) return;
    const steps = this.guide.steps;
    index = Math.max(0, Math.min(steps.length - 1, index));
    const going = animate && !this.reduceMotion;
    const now = performance.now();

    const shown = new Set<string>();
    for (const step of steps.slice(0, index + 1)) {
      step.show.forEach((id) => shown.add(id));
      (step.place ?? []).forEach((p) => shown.add(p.part));
      for (const c of step.connections) shown.add(c.from.part).add(c.to.part);
    }
    const current = steps[index];
    const moves = new Map((current.place ?? []).map((p) => [p.part, p]));
    // everything where it is on this step before framing; arrivals start from there
    this.arriving.clear();
    let order = 0;
    for (const [id, model] of this.models) {
      const before = model.target.clone();
      const waiting = model.loose && index < (this.builtAt.get(id) ?? Infinity);
      model.target.copy(waiting ? model.loose! : model.rest);
      model.group.position.copy(model.target);
      // from the bench into the build: it travels from where it was waiting
      const travels = this.visible.has(id) && shown.has(id) && !before.equals(model.target);
      const arrives = shown.has(id) && (!this.visible.has(id) || moves.has(id) || travels);
      if (!shown.has(id)) model.setOpacity(0);
      else if (!arrives || !going) model.setOpacity(1);
      if (arrives && going) {
        const move = moves.get(id);
        const from = travels ? before.sub(model.target) : this.offset(model, move?.from ?? null, move?.distance ?? 0);
        this.arriving.set(id, { start: now + 120 * order++, from, duration: travels ? 1100 : move ? 900 : 600 });
      }
    }
    this.visible = shown;

    this.clearWires();
    // earlier wires stay, except the ones that were unplugged again
    steps.slice(0, index).forEach((step) => step.connections.forEach((c) => !c.temporary && this.addWire(c, false, -1)));
    const wireDelay = going ? 250 + (moves.size ? 700 : 0) : -1;
    current.connections.forEach((c, i) => this.addWire(c, true, wireDelay < 0 ? -1 : wireDelay + i * 160));

    if (current.view) this.dir = VIEWS[current.view].clone().normalize();
    // the parts going in now are what to look at, along with whatever the step points to
    this.focus([...current.focus, ...moves.keys()], current.connections, going);
    this.step = index;
  }

  /** where a part starts its slide in from, relative to where it belongs */
  private offset(model: PartModel, from: Approach | Vec3 | null, distance: number) {
    if (!from) return new THREE.Vector3(0, 0, 0).setComponent(model.part.pose ? 2 : 1, 8);
    const d = new THREE.Vector3(...(typeof from === 'string' ? APPROACH[from] : from)).normalize();
    // the table's frame is y up: the build's z becomes y, its y points away (-z)
    if (!model.part.pose) d.set(d.x, d.z, -d.y);
    const size = model.box.getSize(new THREE.Vector3());
    return d.multiplyScalar(distance || Math.max(30, Math.max(size.x, size.y, size.z) * 1.2));
  }

  /** what the guide agent wants shown alongside an answer */
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

  /** a point on a part where it rests, in the scene */
  private atRest(model: PartModel, local: THREE.Vector3) {
    const parent = model.group.parent ?? this.scene;
    parent.updateWorldMatrix(true, false);
    const matrix = new THREE.Matrix4().compose(model.target, model.group.quaternion, model.group.scale);
    return local.clone().applyMatrix4(matrix).applyMatrix4(parent.matrixWorld);
  }

  private pinWorld(end: { part: string; pin: string }) {
    const model = this.models.get(end.part);
    if (!model) return null;
    return this.atRest(model, model.anchor(end.pin));
  }

  /** a routing point: [x, y, z] in the build's frame, or the top of a part it runs past */
  private viaWorld(point: Vec3 | string) {
    if (typeof point === 'string') {
      const model = this.models.get(point);
      if (!model) return null;
      return this.atRest(model, model.anchor(''));
    }
    this.assembly.updateWorldMatrix(true, false);
    return new THREE.Vector3(...point).applyMatrix4(this.assembly.matrixWorld);
  }

  private addWire(c: Connection, current: boolean, delay: number) {
    const a = this.pinWorld(c.from);
    const b = this.pinWorld(c.to);
    if (!a || !b) return;
    const via = (c.via ?? []).map((p) => this.viaWorld(p)).filter((p) => !!p);
    const wire = new Wire(a, b, c.wire, via);
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
      for (const e of [c.from, c.to]) if (e.pin) pins.set(e.part, [...(pins.get(e.part) ?? []), e.pin]);
      else whole.add(e.part);
    }
    for (const [id, model] of this.models) {
      model.highlight(whole.has(id) || pins.has(id), whole.has(id) ? [] : (pins.get(id) ?? []));
    }

    // frame what's in focus, or everything showing; parts are measured where they rest, not
    // mid-slide. Something going into the build is shown with the build around it, the way a
    // LEGO page always shows the whole model
    const box = new THREE.Box3();
    const focused = [...whole, ...pins.keys()].filter((id) => this.visible.has(id));
    const intoBuild = focused.some((id) => this.models.get(id)?.part.pose);
    const built = [...this.visible].filter((id) => this.models.get(id)?.part.pose);
    const framed = focused.length ? [...focused, ...(intoBuild ? built : [])] : [...this.visible];
    for (const id of new Set(framed)) {
      const model = this.models.get(id);
      if (!model) continue;
      const corners = [model.box.min, model.box.max];
      for (let i = 0; i < 8; i++) {
        box.expandByPoint(this.atRest(model, new THREE.Vector3(corners[i & 1].x, corners[(i >> 1) & 1].y, corners[(i >> 2) & 1].z)));
      }
    }
    for (const { wire, current } of this.wires) if (current) box.expandByObject(wire.group);
    if (box.isEmpty()) return;
    // a single small part is shown with some of the build around it
    const size = box.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) < 40) box.expandByScalar((40 - Math.max(size.x, size.y, size.z)) / 2);
    this.flyTo(box, animate);
  }

  private flyTo(box: THREE.Box3, animate: boolean) {
    const centre = box.getCenter(new THREE.Vector3());
    // measure the box as the camera will see it from where it's heading, to find the zoom that
    // fits it with a margin
    const eye = new THREE.Object3D();
    eye.position.copy(centre).addScaledVector(this.dir, DISTANCE);
    eye.up.copy(this.camera.up);
    eye.lookAt(centre);
    eye.updateMatrixWorld(true);
    const view = eye.matrixWorld.clone().invert();
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view),
    );
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const cover = this.covered();
    const freeX = Math.max(0.3, 1 - (cover.left + cover.right) / Math.max(1, this.host.clientWidth));
    const freeY = Math.max(0.3, 1 - (cover.top + cover.bottom) / Math.max(1, this.host.clientHeight));
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    const zoom = Math.min((VIEW * aspect * freeX) / Math.max(width, 1), (VIEW * freeY) / Math.max(height, 1)) * 0.8;
    const toZoom = THREE.MathUtils.clamp(zoom, this.controls.minZoom, this.controls.maxZoom);
    if (!animate) {
      this.moveTo(centre, toZoom, this.dir);
      return;
    }
    const fromDir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flight = { from: this.controls.target.clone(), to: centre, fromZoom: this.camera.zoom, toZoom, fromDir, toDir: this.dir.clone(), start: performance.now() };
  }

  private moveTo(target: THREE.Vector3, zoom: number, dir: THREE.Vector3) {
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, DISTANCE);
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
    // centre the drawing in the part of the screen the cards leave free
    const cover = this.covered();
    this.camera.setViewOffset(w, h, (cover.right - cover.left) / 2, (cover.bottom - cover.top) / 2, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** call when the covered area changes size: the camera re-frames what it was showing */
  refit(animate = false) {
    this.resize();
    if (this.lastFocus && !this.flight) this.focus(this.lastFocus.targets, this.lastFocus.connections, animate && !this.reduceMotion);
  }

  private frame() {
    const now = performance.now();
    if (this.flight) {
      const f = this.flight;
      // turning to another side takes a little longer than gliding across
      const t = (now - f.start) / (f.fromDir.angleTo(f.toDir) > 0.3 ? 1000 : 700);
      const k = easeInOut(t);
      const dir = f.fromDir.clone().lerp(f.toDir, k);
      if (dir.lengthSq() < 1e-6) dir.copy(f.toDir);
      this.moveTo(f.from.clone().lerp(f.to, k), THREE.MathUtils.lerp(f.fromZoom, f.toZoom, k), dir.normalize());
      if (t >= 1) this.flight = null;
    }
    this.controls.enabled = !this.flight;
    this.controls.update();

    // parts slide in from where the hand brings them, fading in over the first part of the way
    for (const [id, a] of this.arriving) {
      const model = this.models.get(id)!;
      const t = Math.max(0, (now - a.start) / a.duration);
      if (model.getOpacity() < 1) model.setOpacity(Math.min(1, t * 2.2));
      model.group.position.copy(model.target).addScaledVector(a.from, 1 - easeGlide(t));
      if (t >= 1) this.arriving.delete(id);
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

    // on a big build only the parts going in now get a balloon, like a LEGO page
    const current = this.guide.steps[this.step];
    const busy = this.visible.size > 8;
    const now = new Set([...(current?.place ?? []).map((p) => p.part), ...(current?.show ?? [])]);
    this.guide.parts.forEach((part, i) => {
      const model = this.models.get(part.id);
      if (!model || !this.visible.has(part.id) || (busy && !now.has(part.id))) return;
      // a numbered balloon off the top of the part, matching the parts list
      const corner = model.part.pose || model.part.mesh ? top(model) : world(model, model.corner());
      const at = project(corner);
      callouts.push({ key: `part-${part.id}`, x: at.x + 22, y: at.y - 30, ax: at.x, ay: at.y, text: String(i + 1), kind: 'part' });
    });

    // labels for the pins being wired right now
    const ends = (current?.connections ?? []).flatMap((c) => [c.from, c.to]).filter((e) => e.pin);
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
          centre: project(world(model, model.centre())),
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

/** the middle of a part's top, where it is right now */
function top(model: PartModel) {
  const box = new THREE.Box3().setFromObject(model.group);
  return new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
}

/** a point on a part, from its own coordinates to the scene's (where it is right now) */
function world(model: PartModel, local: THREE.Vector3) {
  model.group.updateWorldMatrix(true, false);
  return model.group.localToWorld(local.clone());
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
