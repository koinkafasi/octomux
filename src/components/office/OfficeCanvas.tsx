/**
 * React binding for the framework-free canvas engine in `src/lib/office/`.
 *
 * The engine is a pile of pure draw functions; everything React-shaped — the element, the
 * backing-store sizing, the frame scheduling and the teardown — lives here. Nothing under
 * `src/lib/office/` is imported for anything but reading.
 *
 * Low motion is the whole design. There is no permanent animation loop: a frame is requested
 * only when the scene, the selection or the element size changes, `shouldRedrawCanvas()`
 * decides whether that frame actually paints, and `needsAnimation()` decides whether another
 * frame follows. With the poses `agents-to-characters.ts` assigns, nothing is ever moving, so
 * the loop paints once and stops until the next real change.
 */

import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import {
  centerCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  needsAnimation,
  render,
  screenToGrid,
  shouldRedrawCanvas,
  TILE_SIZE,
  type Camera,
  type RenderState,
  type RenderViewport,
} from '@/lib/office';
import { findCharacterAt, type OfficeScene } from './agents-to-characters.js';

/**
 * Used only before the element has been laid out (and in a DOM implementation that never lays
 * anything out — happy-dom reports every `clientWidth` as 0). A real browser replaces these on
 * the first frame after mount. Exported so a test can reproduce the camera the component used.
 */
export const FALLBACK_VIEWPORT = { width: 960, height: 600 };

/** Painted under the map so the outdoor tiles do not sit on the page background. */
const BACKDROP = '#0a0d12';

export interface OfficeCanvasProps {
  scene: OfficeScene;
  selectedCharacterId?: string | null;
  onSelectCharacter?: (characterId: string | null) => void;
  /** Tints the whole viewport by time of day. Off by default — it is pure decoration. */
  ambientLighting?: boolean;
  className?: string;
  /** Describes the scene for assistive tech; the canvas itself is opaque to it. */
  label?: string;
}

/**
 * Largest integer zoom that fits the whole map, clamped to the engine's own bounds. Integer
 * only: a fractional zoom lands 16px tiles on half pixels and the art stops being pixel art.
 */
export function fitZoom(cols: number, rows: number, width: number, height: number): number {
  if (cols <= 0 || rows <= 0 || width <= 0 || height <= 0) return MIN_ZOOM;
  const byWidth = width / (cols * TILE_SIZE);
  const byHeight = height / (rows * TILE_SIZE);
  const raw = Math.floor(Math.min(byWidth, byHeight));
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, raw));
}

export function OfficeCanvas({
  scene,
  selectedCharacterId = null,
  onSelectCharacter,
  ambientLighting = false,
  className,
  label = 'Pixel-art office view of the running agents',
}: OfficeCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Last state/viewport actually painted, for the engine's dirty check.
  const paintedStateRef = useRef<RenderState | null>(null);
  const paintedViewportRef = useRef<RenderViewport | null>(null);
  // Last camera used, so a click can be converted back into grid coordinates.
  const cameraRef = useRef<Camera | null>(null);

  const drawRef = useRef<() => boolean>(() => false);
  const scheduleRef = useRef<(() => void) | null>(null);

  /** Paints if anything changed. Returns whether another frame is needed. */
  const draw = useCallback((): boolean => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return false;

    const cssWidth = Math.max(1, Math.round(container.clientWidth || FALLBACK_VIEWPORT.width));
    const cssHeight = Math.max(1, Math.round(container.clientHeight || FALLBACK_VIEWPORT.height));
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const viewport: RenderViewport = { width: cssWidth, height: cssHeight, dpr };

    const { layout } = scene;
    const zoom = fitZoom(layout.cols, layout.rows, cssWidth, cssHeight);
    const camera = centerCamera(layout.cols, layout.rows, cssWidth, cssHeight, zoom);
    cameraRef.current = camera;

    const state: RenderState = {
      grid: layout.grid,
      furniture: layout.furniture,
      characters: scene.characters,
      camera,
      bubbles: scene.bubbles,
      selectedCharacterId,
      cols: layout.cols,
      rows: layout.rows,
      ambientLighting,
    };

    // The dirty check hashes every character through `characterSignature()` (id, state,
    // direction, position, anim frame, path progress). A poll that changed no agent's
    // activity produces identical signatures and this returns false — no repaint at all.
    if (!shouldRedrawCanvas(paintedStateRef.current, state, paintedViewportRef.current, viewport)) {
      return needsAnimation(state);
    }

    // No 2D context: a headless DOM (happy-dom returns null here), a blocked canvas, or an
    // element that lost its context. Nothing to draw and nothing to retry on a timer — bail
    // without recording the state, so a later frame in a context-capable environment paints.
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    render(ctx, state);

    paintedStateRef.current = state;
    paintedViewportRef.current = viewport;
    return needsAnimation(state);
  }, [scene, selectedCharacterId, ambientLighting]);

  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Owns the frame loop for the lifetime of the component. Mount-only on purpose: the effect
  // below asks it for a frame whenever there is something new to paint.
  useEffect(() => {
    let frame: number | null = null;
    let pending = false;
    let disposed = false;

    const step = () => {
      pending = false;
      frame = null;
      if (disposed) return;
      if (drawRef.current()) schedule();
    };

    const schedule = () => {
      if (disposed || pending) return;
      pending = true;
      // `pending` rather than `frame !== null`, because a shimmed or polyfilled rAF may run
      // `step` before it returns: by then the frame is already spent, and its handle must not
      // be recorded as cancellable or block the next schedule.
      const handle = requestAnimationFrame(step);
      if (pending) frame = handle;
    };

    // No initial schedule here: the effect below runs right after this one on mount and asks
    // for the first frame. Scheduling in both places would paint the same frame twice.
    scheduleRef.current = schedule;

    const onResize = () => schedule();
    window.addEventListener('resize', onResize);

    let observer: ResizeObserver | undefined;
    if (containerRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onResize);
      observer.observe(containerRef.current);
    }

    return () => {
      disposed = true;
      scheduleRef.current = null;
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
  }, []);

  // One frame per real change. The dirty check still gets the last word on whether it paints.
  useEffect(() => {
    scheduleRef.current?.();
  }, [draw]);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      if (!onSelectCharacter) return;
      const camera = cameraRef.current;
      const canvas = canvasRef.current;
      if (!camera || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cell = screenToGrid(camera, event.clientX - rect.left, event.clientY - rect.top);
      onSelectCharacter(findCharacterAt(scene.characters, cell.x, cell.y));
    },
    [onSelectCharacter, scene.characters],
  );

  return (
    <div ref={containerRef} data-testid="office-canvas-host" className={className}>
      <canvas
        ref={canvasRef}
        data-testid="office-canvas"
        role="img"
        aria-label={label}
        onClick={handleClick}
        className="block h-full w-full"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
