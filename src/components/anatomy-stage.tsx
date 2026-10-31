import { useEffect, useRef } from "react";
import { PALETTE } from "@/lib/palette";

export type AnatomyItem = {
  id: string;
  kind: "uterus" | "ovary" | "fibroid" | "lesion" | "cyst" | "symptom" | "follicle";
  position: [number, number, number];
  radii: [number, number, number];
  tone: "pine" | "clay" | "ink" | "ghost";
};

type Surface = { positions: Float32Array; indices: Uint32Array };

type Props = {
  items: AnatomyItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  hidden: Record<string, boolean>;
  surface: Surface | null;
};

export function AnatomyStage({ items, selectedId, onSelect, hidden, surface }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const key = JSON.stringify({
    items,
    selectedId,
    hidden,
    triangles: surface?.indices.length ?? 0,
    first: surface?.positions[0] ?? 0,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let stopped = false;
    let cleanup = () => {};
    void (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
      if (stopped || !hostRef.current) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(PALETTE.paper);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 80);
      camera.position.set(7.2, 4.6, 12);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.set(0, 0.15, 0);
      scene.add(new THREE.AmbientLight(PALETTE.card, 0.55));
      const keyLight = new THREE.DirectionalLight(PALETTE.card, 1.35);
      keyLight.position.set(5, 9, 6);
      scene.add(keyLight);
      scene.add(new THREE.HemisphereLight(PALETTE.paper, PALETTE.line, 0.65));

      const deck = new THREE.Mesh(
        new THREE.CircleGeometry(4.4, 64),
        new THREE.MeshStandardMaterial({ color: PALETTE.line, roughness: 1 }),
      );
      deck.rotation.x = -Math.PI / 2;
      deck.position.y = -2.35;
      scene.add(deck);

      const tones = { pine: PALETTE.pine, clay: PALETTE.clay, ink: PALETTE.ink, ghost: PALETTE.mist };
      const pickable: import("three").Object3D[] = [];

      for (const item of items) {
        if (hidden[item.kind]) continue;
        let geometry: import("three").BufferGeometry;
        const useSurface = item.id === selectedId && surface && (item.kind === "fibroid" || item.kind === "lesion" || item.kind === "cyst");
        if (item.kind === "uterus") {
          geometry = new THREE.LatheGeometry(
            [
              new THREE.Vector2(0.16, -1.85),
              new THREE.Vector2(0.46, -1.3),
              new THREE.Vector2(0.58, -0.85),
              new THREE.Vector2(1.08, -0.1),
              new THREE.Vector2(1.22, 0.75),
              new THREE.Vector2(0.78, 1.5),
              new THREE.Vector2(0.18, 1.78),
            ],
            48,
          );
        } else if (useSurface && surface) {
          geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(surface.positions.slice(), 3));
          geometry.setIndex(new THREE.BufferAttribute(surface.indices.slice(), 1));
          geometry.computeVertexNormals();
          geometry.scale(0.1, 0.1, 0.1);
          geometry.translate(item.position[0], item.position[1], item.position[2]);
        } else {
          geometry = new THREE.SphereGeometry(1, item.kind === "follicle" ? 8 : 32, 24);
          geometry.scale(item.radii[0], item.radii[1], item.radii[2]);
          geometry.translate(item.position[0], item.position[1], item.position[2]);
        }
        const selected = item.id === selectedId;
        const material = new THREE.MeshStandardMaterial({
          color: tones[item.tone],
          roughness: item.kind === "uterus" ? 0.62 : 0.48,
          metalness: 0,
          transparent: item.tone === "ghost" || item.kind === "symptom" || item.kind === "follicle",
          opacity: item.tone === "ghost" ? 0.32 : item.kind === "follicle" ? 0.85 : 1,
          wireframe: item.kind === "symptom",
          emissive: selected ? new THREE.Color(PALETTE.clay) : new THREE.Color(PALETTE.ink),
          emissiveIntensity: selected ? 0.18 : 0,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.selectId = item.id;
        scene.add(mesh);
        if (item.kind !== "uterus" && item.kind !== "ovary" && item.kind !== "follicle") pickable.push(mesh);
      }

      const axes = new THREE.AxesHelper(1.5);
      axes.position.set(-3.4, -2.15, 0);
      scene.add(axes);

      host.appendChild(renderer.domElement);
      const resize = () => {
        const w = host.clientWidth || 320;
        const h = host.clientHeight || 320;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let downX = 0;
      let downY = 0;
      const onDown = (event: PointerEvent) => {
        downX = event.clientX;
        downY = event.clientY;
      };
      const onUp = (event: PointerEvent) => {
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(pickable, false)[0];
        onSelectRef.current((hit?.object.userData.selectId as string | undefined) ?? null);
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointerup", onUp);

      let frame = 0;
      const loop = () => {
        frame = requestAnimationFrame(loop);
        controls.update();
        renderer.render(scene, camera);
      };
      loop();

      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        controls.dispose();
        scene.traverse((obj) => {
          const mesh = obj as import("three").Mesh;
          mesh.geometry?.dispose();
          const material = mesh.material as import("three").Material | import("three").Material[] | undefined;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material?.dispose();
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();
    return () => {
      stopped = true;
      cleanup();
    };
    // key captures the scene inputs; refs cover the host and callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <div ref={hostRef} className="h-full min-h-80 w-full touch-none" />;
}
