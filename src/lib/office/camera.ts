/**
 * Ported from agora-lab (https://github.com/LiXin97/agora-lab),
 * packages/web/src/engine/camera.ts.
 * Copyright the agora-lab authors. Licensed under the Apache License 2.0.
 * Modifications: dropped the two dead `- 0` terms in createCamera and pulled the zoom
 * clamp bounds out into exported MIN_ZOOM / MAX_ZOOM constants; the maths is unchanged.
 */

import type { Camera, Character } from './types.js';
import { TILE_SIZE } from './types.js';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export function createCamera(cols = 24, rows = 18, zoom = 2): Camera {
  // Center camera on the middle of the map (adjusted at runtime by canvas size)
  return {
    x: (cols * TILE_SIZE * zoom) / 2,
    y: (rows * TILE_SIZE * zoom) / 2,
    zoom,
  };
}

export function centerCamera(
  cols: number,
  rows: number,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
): Camera {
  return {
    x: (cols * TILE_SIZE * zoom - canvasWidth) / 2,
    y: (rows * TILE_SIZE * zoom - canvasHeight) / 2,
    zoom,
  };
}

export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x + dx, y: camera.y + dy };
}

export function zoomCamera(camera: Camera, direction: 1 | -1): Camera {
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom + direction));
  return { ...camera, zoom: newZoom };
}

export function followCharacter(
  camera: Camera,
  character: Character,
  canvasWidth: number,
  canvasHeight: number,
): Camera {
  const targetX = character.x * camera.zoom - canvasWidth / 2 + (TILE_SIZE * camera.zoom) / 2;
  const targetY = character.y * camera.zoom - canvasHeight / 2 + (TILE_SIZE * camera.zoom) / 2;
  const lerp = 0.1;
  return {
    ...camera,
    x: camera.x + (targetX - camera.x) * lerp,
    y: camera.y + (targetY - camera.y) * lerp,
  };
}

export function screenToGrid(
  camera: Camera,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: Math.floor((screenX + camera.x) / (TILE_SIZE * camera.zoom)),
    y: Math.floor((screenY + camera.y) / (TILE_SIZE * camera.zoom)),
  };
}
