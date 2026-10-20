import * as THREE from 'three';
import { easeExpo, easeGlide, ink, red, wireColor } from './look';

// A jumper wire from one pin to another: an arc in its real colour with an ink outline,
// and a small black plug housing on each end. It can draw itself in and then push its
// plugs down onto the pins, the way you'd actually do it.

const SEGMENTS = 64;
const RADIAL = 8;
const PLUG = 9; // dupont housing length

/** what's on the end of a wire: a jumper's plug, nothing (a shared plug housing or the part
 * itself holds it), or a plug lying free on the table */
export type Tip = 'plug' | 'none' | 'free';

export class Wire {
  readonly group = new THREE.Group();
  private readonly tubes: THREE.Mesh[] = [];
  private readonly plugs: THREE.Group[] = [];
  private readonly outline: THREE.MeshBasicMaterial;
  private readonly materials: THREE.Material[] = [];
  private started = 0;
  private duration = 0;
  /** 0 while the plugs are still above their pins, 1 once they're pushed home */
  seated = 1;

  constructor(
    readonly a: THREE.Vector3,
    readonly b: THREE.Vector3,
    readonly colour: string,
    /** where the cable is routed, in order; without it, it arcs over */
    via: THREE.Vector3[] = [],
    readonly tips: [Tip, Tip] = ['plug', 'plug'],
  ) {
    const lift = 10 + a.distanceTo(b) * 0.32;
    const up = new THREE.Vector3(0, 1, 0);
    // a free end comes down to the table rather than standing on a pin
    const startAt = a.clone().addScaledVector(up, PLUG);
    const endAt = tips[1] === 'free' ? b.clone() : b.clone().addScaledVector(up, PLUG);
    const curve: THREE.Curve<THREE.Vector3> = via.length
      ? new THREE.CatmullRomCurve3([startAt, ...via, endAt], false, 'centripetal')
      : new THREE.CubicBezierCurve3(
          startAt,
          a.clone().addScaledVector(up, PLUG + lift),
          tips[1] === 'free' ? b.clone().addScaledVector(up, lift * 0.6) : b.clone().addScaledVector(up, PLUG + lift),
          endAt,
        );
    this.outline = new THREE.MeshBasicMaterial({ color: ink, side: THREE.BackSide, transparent: true });
    const core = new THREE.MeshBasicMaterial({ color: wireColor(colour), transparent: true });
    const outer = new THREE.Mesh(new THREE.TubeGeometry(curve, SEGMENTS, 0.78, RADIAL), this.outline);
    const inner = new THREE.Mesh(new THREE.TubeGeometry(curve, SEGMENTS, 0.52, RADIAL), core);
    this.tubes.push(outer, inner);
    this.materials.push(this.outline, core);
    this.group.add(outer, inner);

    for (const [i, end] of [a, b].entries()) {
      const plug = new THREE.Group();
      plug.visible = tips[i] !== 'none';
      plug.userData.tip = tips[i];
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
      // a free plug lies on the table, pointing away from where the wire comes from
      if (tips[i] === 'free') {
        const away = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
        plug.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), away);
        plug.position.y = 1.25;
      }
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
    start.visible = draw > 0.02 && this.tips[0] !== 'none';
    end.visible = draw > 0.98 && this.tips[1] !== 'none';
    // plugs slide down onto their pins; a free end just lies there
    start.position.y = this.a.y + (1 - seat) * 7;
    if (this.tips[1] !== 'free') end.position.y = this.b.y + (1 - seat) * 7;
    // the wire rides up with its plugs until they're seated
    for (const tube of this.tubes) tube.position.y = this.tips[1] === 'free' ? 0 : (1 - seat) * 7;
    this.seated = seat;
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
