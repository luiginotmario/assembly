import * as THREE from 'three';
import type { Feature, Part, Pin, Side } from '../../../shared/types';
import { ink, outlined, red, silkscreen, tint } from './look';

// One part, drawn from its spec: the board, its pins with their printed labels, and
// anything that sticks out (usb plugs, sockets). Centred on its own origin, lying flat.

const HEADER = 6; // how tall a header pin stands above the board
const SOCKET = 4.5; // how tall a socket housing is

export class PartModel {
  readonly group = new THREE.Group();
  private readonly anchors = new Map<string, THREE.Vector3>();
  private readonly outlines: THREE.LineBasicMaterial[] = [];
  private readonly fills: THREE.Material[] = [];
  private readonly pinMarks = new Map<string, THREE.Mesh>();

  constructor(readonly part: Part) {
    const { w, h, t } = part.size;
    const board = outlined(new THREE.BoxGeometry(w, t, h).translate(0, t / 2, 0), tint(part.color));
    this.group.add(board);

    for (const feature of part.features) this.addFeature(feature);

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
      this.group.add(ring);
    }

    this.group.traverse((o) => {
      if (o instanceof THREE.LineSegments && o.userData.outline) this.outlines.push(o.material as THREE.LineBasicMaterial);
      const material = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (material) this.fills.push(material);
    });
    for (const m of this.fills) m.userData.opacity = (m as THREE.MeshBasicMaterial).opacity ?? 1;
  }

  /** where a pin's wire attaches, in the part's own coordinates */
  anchor(pinId: string) {
    return this.anchors.get(pinId)?.clone() ?? new THREE.Vector3(0, this.part.size.t, 0);
  }

  get pins() {
    return [...this.anchors.keys()];
  }

  /** the drawing's red pen: this part, or some of its pins, are what to look at */
  highlight(on: boolean, pins: string[] = []) {
    for (const m of this.outlines) m.color.set(on && !pins.length ? red : ink);
    for (const [id, mark] of this.pinMarks) mark.visible = on && pins.includes(id);
  }

  setOpacity(value: number) {
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
    const { at, inward } = this.onSide(pin.side, offset, inset);
    const along = pin.side === 'top' || pin.side === 'bottom';
    let top = t;

    if (pin.style === 'header') {
      const base = outlined(new THREE.BoxGeometry(pitch * 0.96, 2.4, pitch * 0.96), '#2b2b2b', '#000');
      base.position.set(at.x, t + 1.2, at.z);
      const metal = outlined(new THREE.BoxGeometry(0.64, HEADER, 0.64), '#d9d6cc', ink);
      metal.position.set(at.x, t + HEADER / 2, at.z);
      this.group.add(base, metal);
      top = t + HEADER;
    } else if (pin.style === 'socket') {
      // one housing per side, drawn with the first pin
      if (i === 0) {
        const length = count * pitch + 2;
        const housing = outlined(new THREE.BoxGeometry(along ? length : 4.6, SOCKET, along ? 4.6 : length), '#fbfaf6');
        const centre = this.onSide(pin.side, 0, inset).at;
        housing.position.set(centre.x, t + SOCKET / 2, centre.z);
        this.group.add(housing);
      }
      const hole = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.7), new THREE.MeshBasicMaterial({ color: ink, transparent: true }));
      hole.position.set(at.x, t + SOCKET + 0.03, at.z);
      this.group.add(hole);
      top = t + SOCKET;
    } else {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.8, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#b9a46a', transparent: true }));
      pad.position.set(at.x, t + 0.02, at.z);
      this.group.add(pad);
    }

    this.anchors.set(pin.id, new THREE.Vector3(at.x, top, at.z));

    // the printed label, just inside the board from the pin
    const size = Math.min(1.6, pitch * 0.62);
    const label = silkscreen(pin.label, size, ink, along ? 'left' : inward.x > 0 ? 'left' : 'right');
    const into = pin.style === 'socket' ? 3.2 : 1.8;
    if (along) {
      // text runs into the board, reading away from the edge
      label.rotation.y = inward.z > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    label.position.set(at.x + inward.x * into, t + 0.03, at.z + inward.z * into);
    this.group.add(label);

    // a red ring that marks this pin when it's the one to look at
    const mark = new THREE.Mesh(
      new THREE.RingGeometry(Math.min(1.1, pitch * 0.32), Math.min(1.45, pitch * 0.46), 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: red, transparent: true, depthTest: false }),
    );
    mark.position.set(at.x, top + 0.05, at.z);
    mark.renderOrder = 10;
    mark.visible = false;
    this.pinMarks.set(pin.id, mark);
    this.group.add(mark);
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
      this.group.add(chip);
      if (feature.label) {
        const text = silkscreen(feature.label, Math.min(1.4, size * 0.22), '#eceae3');
        text.position.set(chip.position.x, t + 1.03, chip.position.z);
        this.group.add(text);
      }
    }
    if (feature.kind === 'usb-a' || feature.kind === 'usb-c') {
      const [width, height, depth] = feature.kind === 'usb-a' ? [12, 4.5, 13] : [9, 3.2, 7.5];
      const plug = outlined(new THREE.BoxGeometry(along ? width : depth, height, along ? depth : width), '#e7e4dc');
      const out = depth / 2 + (feature.kind === 'usb-a' ? -2 : 0);
      const pos = this.onSide(feature.side, offset, -out).at;
      plug.position.set(pos.x, t + height / 2, pos.z);
      this.group.add(plug);
    }
    if (feature.kind === 'antenna') {
      const patch = outlined(new THREE.BoxGeometry(Math.min(w, h) * 0.22, 0.04, Math.min(w, h) * 0.3), '#d8c58e', '#8a7a48');
      for (const dx of [-1, 1]) {
        const p = patch.clone();
        p.position.set(dx * w * 0.24, t + 0.02, h * 0.12);
        this.group.add(p);
      }
    }
  }
}
