import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { PALETTE } from "@/lib/palette";
import type { Mesh } from "@/lib/imaging/isosurface";
import type { Axis } from "@/lib/imaging/lab";
import type { Vec3 } from "@/lib/imaging/volume";

export type VolumeStageHandle = { resetView: () => void };

type Props = {
  /** Mesh in image-index millimetres (x = column, y = row, z = slice), or null before a segmentation exists. */
  mesh: Mesh | null;
  /** Physical extent of the voxel centres, mm: (n - 1) × spacing on each axis. */
  extentMm: Vec3;
  /** The slice currently shown in the 2D viewer, as a position in mm along its axis. */
  plane: { axis: Axis; mm: number } | null;
  seedMm: Vec3 | null;
  ref?: Ref<VolumeStageHandle>;
};

type Api = {
  setMesh: (mesh: Mesh | null) => void;
  setPlane: (plane: { axis: Axis; mm: number } | null) => void;
  setSeed: (seed: Vec3 | null) => void;
  resetView: () => void;
};

/**
 * Renders a segmentation mesh with its volume bounding box, the current slice plane and the seed. The scene is built
 * once; mesh, plane and seed are swapped in place so scrubbing slices neither rebuilds the scene nor moves the camera.
 * Image axes are drawn as a triad: x (columns) red, y (rows) green, z (slices) blue. No anatomical orientation is implied.
 */
export function VolumeStage({ mesh, extentMm, plane, seedMm, ref }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const latest = useRef({ mesh, plane, seedMm });
  latest.current = { mesh, plane, seedMm };
  const [failed, setFailed] = useState<string | null>(null);
  const extentKey = extentMm.join("x");

  useImperativeHandle(ref, () => ({ resetView: () => apiRef.current?.resetView() }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let stopped = false;
    let cleanup = () => {};
    setFailed(null);
    void (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
        if (stopped || !hostRef.current) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(PALETTE.paper);

        const [ex, ey, ez] = extentMm;
        const diag = Math.max(1, Math.hypot(ex, ey, ez));
        const camera = new THREE.PerspectiveCamera(35, 1, diag / 200, diag * 20);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;

        scene.add(new THREE.AmbientLight(PALETTE.card, 0.6));
        const key = new THREE.DirectionalLight(PALETTE.card, 1.3);
        key.position.set(diag, diag * 1.4, diag);
        scene.add(key);
        scene.add(new THREE.HemisphereLight(PALETTE.paper, PALETTE.line, 0.7));

        // Image-index space (x right, y down the rows, z along the slices) → a proper rotation into y-up scene space,
        // so slice 0 faces the viewer and nothing is mirrored.
        const root = new THREE.Group();
        root.scale.set(1, -1, -1);
        root.position.set(-ex / 2, ey / 2, ez / 2);
        scene.add(root);

        const box = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(Math.max(ex, 1e-3), Math.max(ey, 1e-3), Math.max(ez, 1e-3))),
          new THREE.LineBasicMaterial({ color: PALETTE.mist }),
        );
        box.position.set(ex / 2, ey / 2, ez / 2);
        root.add(box);

        const triad = new THREE.Group();
        const arm = diag * 0.12;
        const arms: [number, number, number, number][] = [
          [arm, 0, 0, 0xc0392b],
          [0, arm, 0, 0x2e8b57],
          [0, 0, arm, 0x2f6db5],
        ];
        for (const [x, y, z, color] of arms) {
          const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, y, z)]);
          triad.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
        }
        root.add(triad);

        const meshMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.pine, roughness: 0.5, metalness: 0, side: THREE.DoubleSide });
        let meshObject: import("three").Mesh | null = null;

        const planeMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.12, depthWrite: false });
        const planeObject = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), planeMaterial);
        planeObject.visible = false;
        root.add(planeObject);

        const seedObject = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(diag * 0.012, 0.3), 16, 12),
          new THREE.MeshBasicMaterial({ color: PALETTE.clay }),
        );
        seedObject.visible = false;
        root.add(seedObject);

        host.appendChild(renderer.domElement);
        let queued = 0;
        const draw = () => {
          queued = 0;
          renderer.render(scene, camera);
        };
        const invalidate = () => {
          if (!queued) queued = requestAnimationFrame(draw);
        };
        controls.addEventListener("change", invalidate);

        const resetView = () => {
          camera.position.set(diag * 0.55, diag * 0.35, diag * 1.35);
          controls.target.set(0, 0, 0);
          controls.update();
          invalidate();
        };

        const api: Api = {
          setMesh(next) {
            if (meshObject) {
              root.remove(meshObject);
              meshObject.geometry.dispose();
              meshObject = null;
            }
            if (next && next.indices.length > 0) {
              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute("position", new THREE.BufferAttribute(next.positions, 3));
              geometry.setIndex(new THREE.BufferAttribute(next.indices, 1));
              geometry.computeVertexNormals();
              meshObject = new THREE.Mesh(geometry, meshMaterial);
              root.add(meshObject);
            }
            invalidate();
          },
          setPlane(next) {
            if (!next) {
              planeObject.visible = false;
              invalidate();
              return;
            }
            const eps = Math.max(diag * 0.004, 0.05);
            const sx = next.axis === 0 ? eps : Math.max(ex, eps);
            const sy = next.axis === 1 ? eps : Math.max(ey, eps);
            const sz = next.axis === 2 ? eps : Math.max(ez, eps);
            planeObject.scale.set(sx, sy, sz);
            planeObject.position.set(next.axis === 0 ? next.mm : ex / 2, next.axis === 1 ? next.mm : ey / 2, next.axis === 2 ? next.mm : ez / 2);
            planeObject.visible = true;
            invalidate();
          },
          setSeed(next) {
            if (!next) seedObject.visible = false;
            else {
              seedObject.position.set(next[0], next[1], next[2]);
              seedObject.visible = true;
            }
            invalidate();
          },
          resetView,
        };
        apiRef.current = api;

        const resize = () => {
          const w = host.clientWidth || 320;
          const h = host.clientHeight || 320;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
          renderer.domElement.style.width = "100%";
          renderer.domElement.style.height = "100%";
          invalidate();
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(host);

        resetView();
        api.setMesh(latest.current.mesh);
        api.setPlane(latest.current.plane);
        api.setSeed(latest.current.seedMm);

        cleanup = () => {
          cancelAnimationFrame(queued);
          observer.disconnect();
          controls.removeEventListener("change", invalidate);
          controls.dispose();
          scene.traverse((obj) => {
            const m = obj as import("three").Mesh;
            m.geometry?.dispose();
          });
          meshMaterial.dispose();
          planeMaterial.dispose();
          renderer.dispose();
          renderer.domElement.remove();
          apiRef.current = null;
        };
      } catch (error) {
        if (!stopped) setFailed(error instanceof Error ? error.message : "The 3D view could not start.");
      }
    })();
    return () => {
      stopped = true;
      cleanup();
    };
    // The scene is rebuilt only when the volume's physical size changes; mesh, plane and seed are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extentKey]);

  useEffect(() => {
    apiRef.current?.setMesh(mesh);
  }, [mesh]);
  useEffect(() => {
    apiRef.current?.setPlane(plane);
  }, [plane?.axis, plane?.mm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    apiRef.current?.setSeed(seedMm);
  }, [seedMm?.[0], seedMm?.[1], seedMm?.[2]]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full min-h-80 w-full touch-none" data-testid="volume-stage">
      <div ref={hostRef} className="absolute inset-0" />
      {failed && (
        <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-clay">
          The 3D view needs WebGL, which this browser did not provide ({failed}). The measurements and STL export still work.
        </p>
      )}
    </div>
  );
}
