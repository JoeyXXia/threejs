import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ComponentRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { LayoutResponse } from '@warehouse-twin/contracts';
import type { CameraMode } from './scene-store';
import { cameraPose, orthographicBounds, smoothProgress } from './camera';

type Motion = { elapsed: number; from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; fromZoom: number; toZoom: number };

export function CameraRig({ layout, mode, request }: { layout: LayoutResponse; mode: CameraMode; request: { locationId: string | null; sequence: number } }) {
  const { set, get, size, invalidate, gl } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const motion = useRef<Motion | null>(null);
  const grid = layout.layoutVersion;
  const overview = useMemo(() => cameraPose(layout, mode, null), [layout, mode]);
  const camera = useMemo(() => {
    const far = Math.max(grid.width, grid.depth) * grid.cellSize * 10;
    const result = mode === 'top' ? new OrthographicCamera(-1, 1, 1, -1, .1, far) : new PerspectiveCamera(42, 1, .1, far);
    result.position.set(...overview.position); result.up.set(0, mode === 'top' ? 0 : 1, mode === 'top' ? -1 : 0);
    result.lookAt(...overview.target); return result;
  }, [grid, mode, overview]);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera }); invalidate();
    return () => { motion.current = null; set({ camera: previous }); };
  }, [camera, get, set, invalidate]);
  useLayoutEffect(() => {
    if (camera instanceof PerspectiveCamera) camera.aspect = size.width / size.height;
    else Object.assign(camera, orthographicBounds(layout, size.width / size.height));
    camera.updateProjectionMatrix(); invalidate();
  }, [camera, layout, size.width, size.height, invalidate]);
  useEffect(() => {
    const pose = cameraPose(layout, mode, request.locationId);
    // Replace one in-flight motion; no queued animations or per-frame React setState.
    motion.current = { elapsed: 0, from: camera.position.clone(), to: new Vector3(...pose.position),
      fromTarget: controls.current?.target.clone() ?? new Vector3(...overview.target), toTarget: new Vector3(...pose.target),
      fromZoom: camera.zoom, toZoom: pose.zoom };
    gl.domElement.dataset.cameraTransition = 'running';
    invalidate();
    return () => { motion.current = null; delete gl.domElement.dataset.cameraTransition; delete gl.domElement.dataset.cameraTarget; };
  }, [camera, mode, layout, request.locationId, request.sequence, overview, invalidate, gl]);
  useFrame((_, delta) => {
    const current = motion.current;
    if (!current || !controls.current) return;
    current.elapsed += Math.min(delta, .1);
    const alpha = smoothProgress(current.elapsed);
    camera.position.lerpVectors(current.from, current.to, alpha);
    controls.current.target.lerpVectors(current.fromTarget, current.toTarget, alpha);
    camera.zoom = current.fromZoom + (current.toZoom - current.fromZoom) * alpha;
    camera.updateProjectionMatrix(); controls.current.update();
    if (current.elapsed >= .65) {
      camera.position.copy(current.to); controls.current.target.copy(current.toTarget); camera.zoom = current.toZoom;
      camera.updateProjectionMatrix(); controls.current.update();
      motion.current = null;
      gl.domElement.dataset.cameraTransition = 'idle';
      gl.domElement.dataset.cameraTarget = JSON.stringify(controls.current.target.toArray());
    }
    else invalidate();
  });
  return <OrbitControls key={camera.uuid} ref={controls} makeDefault camera={camera} target={overview.target}
    enableDamping={false}
    enableRotate={mode === 'perspective'} maxPolarAngle={mode === 'top' ? Math.PI : Math.PI * .47} minDistance={grid.cellSize * 2}
    maxDistance={Math.max(grid.width, grid.depth) * grid.cellSize * 3} minZoom={.5} maxZoom={12}
    onStart={() => { motion.current = null; gl.domElement.dataset.cameraTransition = 'idle'; }} />;
}
