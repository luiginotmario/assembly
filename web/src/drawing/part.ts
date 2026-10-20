import * as THREE from 'three';
import type { Feature, Part, Pin, Side } from '../../../shared/types';
import { fill, ink, lines, outlined, red, silkscreen, tint } from './look';
import { copyOf, unitScale } from './mesh';

// One part. With a real 3d model (a printed part, a motor, a board from its maker's CAD) it's
// that model, in its own colour. Otherwise it's drawn from its spec: the board, its pins with
// their printed labels, and anything that sticks out (usb plugs, sockets), lying flat.
// When there's a photo of the real board, the photo is its top surface and its pins sit
// exactly where they were measured; the drawn labels and chip step aside for the real ones.
//
// `group` is where the drawing places it; everything else hangs off `body`. Parts with a pose
// live in the build's own frame (z up, like CAD); the rest lie on the table (y up).

const loader = new THREE.TextureLoader();

const HEADER = 6; // how tall a header pin stands above the board
const SOCKET = 4.5; // how tall a socket housing is

export class PartModel {
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  /** where it belongs; the drawing slides it in from elsewhere */
  readonly rest = new THREE.Vector3();
  /** where it waits on the table while it's used before being built in, if it is */
  loose: THREE.Vector3 | null = null;
  /** where it is on the step being shown: rest, or loose */
  readonly target = new THREE.Vector3();
  /** its extent in its own (group) coordinates */
  readonly box = new THREE.Box3();
  private readonly anchors = new Map<string, THREE.Vector3>();
  private readonly outlines: THREE.LineBasicMaterial[] = [];
  private readonly fills: THREE.Material[] = [];
  private readonly pinMarks = new Map<string, THREE.Mesh>();

  constructor(readonly part: Part) {
    this.group.userData.partId = part.id;
    this.group.add(this.body);
    if (part.mesh) this.model();
    else this.board();
    this.group.updateMatrixWorld(true);
    this.box.setFromObject(this.body);
    if (this.box.isEmpty()) this.box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 5, 5));

    this.group.traverse((o) => {
      if (o instanceof THREE.LineSegments && o.userData.outline) this.outlines.push(o.material as THREE.LineBasicMaterial);
      // a photo-covered board has one material per face
      const material = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of [material].flat()) if (m && !this.fills.includes(m)) this.fills.push(m);
    });
    for (const m of this.fills) m.userData.opacity = (m as THREE.MeshBasicMaterial).opacity ?? 1;
  }

  /** the real model, scaled to millimetres and outlined at its sharp edges */
  private model() {
    const mesh = this.part.mesh!;
    const model = copyOf(mesh.url);
    if (!model) {
      // the file couldn't be loaded: a plain block in its place, marked as a stand-in
      const size = 20;
      const block = outlined(new THREE.BoxGeometry(size, size, size).translate(0, size / 2, 0), tint(this.part.color));
      this.body.add(block);
      return;
    }
    const holder = new THREE.Group();
    holder.scale.setScalar(unitScale(mesh));
    holder.add(model);
    const gltf = /\.(glb|gltf)(\?|$)/i.test(mesh.url);
    // CAD files are z up and so is a posed part's frame; GLB is y up, like the table
    if (this.part.pose && gltf) holder.rotation.x = Math.PI / 2;
    if (!this.part.pose && !gltf) holder.rotation.x = -Math.PI / 2;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.ownMaterial) {
        m.material = [m.material].flat().map((x) => Object.assign(x.clone(), { transparent: true }))[0];
      } else {
        m.material = fill(this.part.color, this.part.finish);
      }
      const edges = new THREE.LineSegments(m.geometry.userData.edges as THREE.BufferGeometry, new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.4 }));
      edges.userData.outline = true;
      m.add(edges);
    });
    this.body.add(holder);
    if (!this.part.pose) {
      // lying on the table: sitting on it, centred
      this.body.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      const centre = box.getCenter(new THREE.Vector3());
      holder.position.set(-centre.x, -box.min.y, -centre.z);
    }
  }

  private board() {
    const part = this.part;
    const { w, h, t } = part.size;
    // a board placed in the build stands in its z-up frame
    if (part.pose) this.body.rotation.x = Math.PI / 2;
    this.body.add(part.texture ? this.photoBoard(part.texture) : outlined(new THREE.BoxGeometry(w, t, h).translate(0, t / 2, 0), tint(part.color), ink, part.finish ?? 'gloss'));

    for (const feature of part.features) {
      // the photo already shows these; plugs and sockets stay as solid shapes for the wires
      if (part.texture && feature.kind !== 'socket') continue;
      this.addFeature(feature);
    }

    const bySide = new Map<Side, Pin[]>();
    for (const pin of part.pins) bySide.set(pin.side, [...(bySide.get(pin.side) ?? []), pin]);
    for (const [, pins] of bySide) {
      pins.sort((a, b) => a.index - b.index);
      pins.forEach((pin, i) => this.addPin(pin, i, pins.length));
    }

    if (part.estimated) {
      // a dashed outline around estimated parts: the shape is a best guess
      const ring = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 3, 0.01, h + 3)),
        new THREE.LineDashedMaterial({ color: ink, dashSize: 1.2, gapSize: 1, transparent: true, opacity: 0.45 }),
      );
      ring.computeLineDistances();
      this.body.add(ring);
    }
  }

  /** the board with the straightened photo of the real one as its top face */
  private photoBoard(url: string) {
    const { w, h, t } = this.part.size;
    const geometry = new THREE.BoxGeometry(w, t, h).translate(0, t / 2, 0);
    const texture = loader.load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const edge = fill(tint(this.part.color, 0.55));
    const top = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
    // box faces: +x, -x, +y (top), -y, +z, -z. the image's top edge lands on the far edge
    const board = new THREE.Mesh(geometry, [edge, edge, top, edge, edge, edge]);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), lines());
    outline.userData.outline = true;
    const group = new THREE.Group();
    group.add(board, outline);
    return group;
  }

  /** where a pin's wire attaches, in the part's own (group) coordinates; a part without that
   * pin (a motor's cable) takes it at the top of the part */
  anchor(pinId: string) {
    const at = this.anchors.get(pinId);
    if (!at) {
      const centre = this.box.getCenter(new THREE.Vector3());
      return this.part.pose ? centre.setZ(this.box.max.z) : centre.setY(this.box.max.y);
    }
    this.body.updateMatrix();
    return at.clone().applyMatrix4(this.body.matrix);
  }

  /** where its numbered balloon points, in its own coordinates */
  corner() {
    if (!this.part.pose && !this.part.mesh) return new THREE.Vector3(this.part.size.w / 2, this.part.size.t, -this.part.size.h / 2);
    return this.box.max.clone();
  }

  centre() {
    return this.box.getCenter(new THREE.Vector3());
  }

  /** how much table it takes, before it's turned */
  footprint() {
    return { w: this.box.max.x - this.box.min.x, h: this.box.max.z - this.box.min.z };
  }

  get pins() {
    return [...this.anchors.keys()];
  }

  /** the drawing's red pen: this part, or some of its pins, are what to look at */
  highlight(on: boolean, pins: string[] = []) {
    for (const m of this.outlines) m.color.set(on && !pins.length ? red : ink);
    for (const [id, mark] of this.pinMarks) mark.visible = on && pins.includes(id);
  }

  getOpacity() {
    return this.opacity;
  }

  private opacity = 1;

  setOpacity(value: number) {
    this.opacity = value;
    for (const m of this.fills) {
      m.opacity = value * (m.userData.opacity ?? 1);
      m.visible = value > 0.001;
    }
  }

  /** a point along a side, and the direction pointing into the board from it */
  private onSide(side: Side, offset: number, inset: number) {
    const { w, h } = this.part.size;
    switch (side) {
      case 'top':
        return { at: new THREE.Vector3(offset, 0, -h / 2 + inset), inward: new THREE.Vector3(0, 0, 1) };
      case 'bottom':
        return { at: new THREE.Vector3(offset, 0, h / 2 - inset), inward: new THREE.Vector3(0, 0, -1) };
      case 'left':
        return { at: new THREE.Vector3(-w / 2 + inset, 0, offset), inward: new THREE.Vector3(1, 0, 0) };
      case 'right':
        return { at: new THREE.Vector3(w / 2 - inset, 0, offset), inward: new THREE.Vector3(-1, 0, 0) };
    }
  }

  private addPin(pin: Pin, i: number, count: number) {
    const { t } = this.part.size;
    const pitch = this.part.pitch || 2.54;
    const offset = (i - (count - 1) / 2) * pitch;
    const inset = pin.style === 'socket' ? 2.6 : 1.4;
    const placed = this.onSide(pin.side, offset, inset);
    const { inward } = placed;
    // measured off a photo of the real board, or spread evenly along its edge
    const at = pin.at ? new THREE.Vector3((pin.at.u - 0.5) * this.part.size.w, 0, (pin.at.v - 0.5) * this.part.size.h) : placed.at;
    const along = pin.side === 'top' || pin.side === 'bottom';
    let top = t;

    if (pin.style === 'header') {
      const base = outlined(new THREE.BoxGeometry(pitch * 0.96, 2.4, pitch * 0.96), '#2b2b2b', '#000');
      base.position.set(at.x, t + 1.2, at.z);
      const metal = outlined(new THREE.BoxGeometry(0.64, HEADER, 0.64), '#d8c27a', ink, 'metal');
      metal.position.set(at.x, t + HEADER / 2, at.z);
      this.body.add(base, metal);
      top = t + HEADER;
    } else if (pin.style === 'socket') {
      // one housing per side, drawn with the first pin
      if (i === 0) {
        const length = count * pitch + 2;
        const housing = outlined(new THREE.BoxGeometry(along ? length : 4.6, SOCKET, along ? 4.6 : length), '#fbfaf6');
        const measured = this.part.pins.filter((p) => p.side === pin.side && p.at);
        const centre = measured.length
          ? new THREE.Vector3(
              measured.reduce((s, p) => s + (p.at!.u - 0.5) * this.part.size.w, 0) / measured.length,
              0,
              measured.reduce((s, p) => s + (p.at!.v - 0.5) * this.part.size.h, 0) / measured.length,
            )
          : this.onSide(pin.side, 0, inset).at;
        housing.position.set(centre.x, t + SOCKET / 2, centre.z);
        this.body.add(housing);
      }
      const hole = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.7), new THREE.MeshBasicMaterial({ color: ink, transparent: true }));
      hole.position.set(at.x, t + SOCKET + 0.03, at.z);
      this.body.add(hole);
      top = t + SOCKET;
    } else {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.8, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#b9a46a', transparent: true }));
      pad.position.set(at.x, t + 0.02, at.z);
      this.body.add(pad);
    }

    this.anchors.set(pin.id, new THREE.Vector3(at.x, top, at.z));

    // the printed label, just inside the board from the pin (a photo already shows the real one)
    if (!this.part.texture) this.addLabel(pin, at, inward, along, pitch);

    // a red ring that marks this pin when it's the one to look at
    const mark = new THREE.Mesh(
      new THREE.RingGeometry(Math.min(1.1, pitch * 0.32), Math.min(1.45, pitch * 0.46), 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: red, transparent: true, depthTest: false }),
    );
    mark.position.set(at.x, top + 0.05, at.z);
    mark.renderOrder = 10;
    mark.visible = false;
    this.pinMarks.set(pin.id, mark);
    this.body.add(mark);
  }

  /** silkscreen is white on dark boards, dark on light ones */
  private printColor() {
    const c = new THREE.Color(this.part.color);
    return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 < 0.45 ? '#f4f3ee' : ink;
  }

  private addLabel(pin: Pin, at: THREE.Vector3, inward: THREE.Vector3, along: boolean, pitch: number) {
    const { t } = this.part.size;
    const size = Math.min(1.6, pitch * 0.62);
    const label = silkscreen(pin.label, size, this.printColor(), along ? 'left' : inward.x > 0 ? 'left' : 'right');
    const into = pin.style === 'socket' ? 3.2 : 1.8;
    if (along) {
      // text runs into the board, reading away from the edge
      label.rotation.y = inward.z > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    label.position.set(at.x + inward.x * into, t + 0.03, at.z + inward.z * into);
    this.body.add(label);
  }

  private addFeature(feature: Feature) {
    const { w, h, t } = this.part.size;
    const along = feature.side === 'top' || feature.side === 'bottom';
    const span = along ? w : h;
    const offset = (feature.at - 0.5) * span;
    if (feature.kind === 'chip') {
      const size = Math.min(w, h) * 0.32;
      const chip = outlined(new THREE.BoxGeometry(size, 1, size), '#2a2a2a', '#000');
      chip.position.set(along ? offset : 0, t + 0.5, along ? 0 : offset);
      this.body.add(chip);
      if (feature.label) {
        const text = silkscreen(feature.label, Math.min(1.4, size * 0.22), '#eceae3');
        text.position.set(chip.position.x, t + 1.03, chip.position.z);
        this.body.add(text);
      }
    }
    if (feature.kind === 'usb-a' || feature.kind === 'usb-c') {
      const [width, height, depth] = feature.kind === 'usb-a' ? [12, 4.5, 13] : [9, 3.2, 7.5];
      const plug = outlined(new THREE.BoxGeometry(along ? width : depth, height, along ? depth : width), '#e7e4dc');
      const out = depth / 2 + (feature.kind === 'usb-a' ? -2 : 0);
      const pos = this.onSide(feature.side, offset, -out).at;
      plug.position.set(pos.x, t + height / 2, pos.z);
      this.body.add(plug);
    }
    if (feature.kind === 'antenna') {
      const patch = outlined(new THREE.BoxGeometry(Math.min(w, h) * 0.22, 0.04, Math.min(w, h) * 0.3), '#d8c58e', '#8a7a48');
      for (const dx of [-1, 1]) {
        const p = patch.clone();
        p.position.set(dx * w * 0.24, t + 0.02, h * 0.12);
        this.body.add(p);
      }
    }
  }
}
