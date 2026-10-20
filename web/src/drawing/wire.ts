import * as THREE from 'three';
import { easeExpo, easeGlide, ink, red, wireColor } from './look';

// A jumper wire from one pin to another: an arc in its real colour with an ink outline,
// and a small black plug housing on each end. It can draw itself in and then push its
// plugs down onto the pins, the way you'd actually do it.

const SEGMENTS = 64;
const RADIAL = 8;
const PLUG = 9; // dupont housing length

export class Wire {
  readonly group = new THREE.Group();
  private readonly tubes: THREE.Mesh[] = [];
  private readonly plugs: THREE.Group[] = [];
  private readonly outline: THREE.MeshBasicMaterial;
  private readonly materials: THREE.Material[] = [];
  private started = 0;
  private duration = 0;

  constructor(
    readonly a: THREE.Vector3,
    readonly b: THREE.Vector3,
    readonly colour: string,
  ) {
    const lift = 10 + a.distanceTo(b) * 0.32;
    const up = new THREE.Vector3(0, 1, 0);
    const curve = new THREE.CubicBezierCurve3(
      a.clone().addScaledVector(up, PLUG),
      a.clone().addScaledVector(up, PLUG + lift),
      b.clone().addScaledVector(up, PLUG + lift),
      b.clone().addScaledVector(up, PLUG),
    );
    this.outline = new THREE.MeshBasicMaterial({ color: ink, side: THREE.BackSide, transparent: true });
    const core = new THREE.MeshBasicMaterial({ color: wireColor(colour), transparent: true });
    const outer = new THREE.Mesh(new THREE.TubeGeometry(curve, SEGMENTS, 0.78, RADIAL), this.outline);
    const inner = new THREE.Mesh(new THREE.TubeGeometry(curve, SEGMENTS, 0.52, RADIAL), core);
    this.tubes.push(outer, inner);
    this.materials.push(this.outline, core);
    this.group.add(outer, inner);

    for (const end of [a, b]) {
      const plug = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, PLUG, 2.5).translate(0, PLUG / 2, 0),
        new THREE.MeshBasicMaterial({ color: '#202020', transparent: true }),
      );
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(2.5, PLUG, 2.5).translate(0, PLUG / 2, 0)),
        new THREE.LineBasicMaterial({ color: '#000', transparent: true }),
      );
      plug.add(body, edge);
      plug.position.copy(end);
      this.materials.push(body.material, edge.material);
      this.plugs.push(plug);
      this.group.add(plug);
    }
  }

  /** draw in from nothing, starting `delay` ms from now */
  animate(delay = 0, duration = 1100) {
    this.started = performance.now() + delay;
    this.duration = duration;
    this.tick(performance.now());
  }

  /** already in place, no animation */
  place() {
    this.duration = 0;
    this.tick(performance.now());
  }

  /** the red pen: this is the wire to do now */
  emphasise(on: boolean) {
    this.outline.color.set(on ? red : ink);
  }

  setOpacity(value: number) {
    for (const m of this.materials) {
      m.opacity = value;
      m.visible = value > 0.001;
    }
  }

  tick(now: number) {
    const t = this.duration ? (now - this.started) / this.duration : 1;
    // the wire draws in over the first 70%, then the plugs slide down onto the pins
    const draw = easeExpo(t / 0.7);
    const seat = easeGlide((t - 0.62) / 0.38);
    for (const tube of this.tubes) {
      const count = tube.geometry.index!.count;
      const step = RADIAL * 6;
      tube.geometry.setDrawRange(0, Math.round((count / step) * draw) * step);
    }
    const [start, end] = this.plugs;
    start.visible = draw > 0.02;
    end.visible = draw > 0.98;
    start.position.y = this.a.y + (1 - seat) * 7;
    end.position.y = this.b.y + (1 - seat) * 7;
    // the wire rides up with its plugs until they're seated
    for (const tube of this.tubes) tube.position.y = (1 - seat) * 7;
    return t < 1;
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}
