import * as THREE from 'three';
import type { Mesh } from '../../../shared/types';

// Real 3d models: a part's STL, OBJ, GLB/GLTF or 3MF, downloaded once per file (a motor used six
// times is one download) and handed out as copies that share their geometry. Outlines are worked
// out once per geometry too.

const cache = new Map<string, Promise<THREE.Object3D>>();
const ready = new Map<string, THREE.Object3D>();
const failed = new Set<string>();

const UNITS: Record<Mesh['units'], number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export const unitScale = (mesh: Mesh) => UNITS[mesh.units] ?? 1;

async function fetchModel(url: string): Promise<THREE.Object3D> {
  const type = url.split(/[?#]/)[0].split('.').pop()!.toLowerCase();
  if (type === 'stl') {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    const geometry = await new STLLoader().loadAsync(url);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry);
  }
  if (type === 'glb' || type === 'gltf') {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    // keeps its own materials (they may be textured); the rest get the part's colour
    gltf.scene.traverse((o) => (o.userData.ownMaterial = true));
    return gltf.scene;
  }
  if (type === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    return new OBJLoader().loadAsync(url);
  }
  if (type === '3mf') {
    const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
    return new ThreeMFLoader().loadAsync(url);
  }
  throw new Error(`can't read .${type} files`);
}

function load(url: string) {
  let pending = cache.get(url);
  if (!pending) {
    pending = fetchModel(url).then((model) => {
      // outlines at sharp edges only, worked out once and shared by every copy
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !mesh.geometry.userData.edges) mesh.geometry.userData.edges = new THREE.EdgesGeometry(mesh.geometry, 40);
      });
      ready.set(url, model);
      return model;
    });
    cache.set(url, pending);
  }
  return pending;
}

/** downloads every model a guide uses, a few at a time, reporting how far it's got */
export async function loadAll(meshes: Mesh[], progress: (done: number, total: number) => void) {
  const urls = [...new Set(meshes.map((m) => m.url))];
  let done = 0;
  progress(done, urls.length);
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift()!;
      try {
        await load(url);
      } catch (error) {
        failed.add(url);
        console.warn(`couldn't load ${url}:`, (error as Error).message);
      }
      progress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { failed: urls.filter((u) => failed.has(u)) };
}

/** a copy of a loaded model, sharing its geometry; null if it isn't loaded (or couldn't be) */
export function copyOf(url: string) {
  const model = ready.get(url);
  return model ? model.clone(true) : null;
}
