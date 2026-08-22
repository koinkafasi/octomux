/**
 * Ported from agora-lab (https://github.com/LiXin97/agora-lab),
 * packages/web/src/engine/sprites.ts.
 * Copyright the agora-lab authors. Licensed under the Apache License 2.0.
 * Modifications: replaced the `getContext('2d')!` non-null assertion with a null guard so
 * the module returns a correctly sized blank canvas instead of throwing in environments
 * with no 2D context (happy-dom returns null there).
 */

export type SpriteData = string[][];

const cache = new WeakMap<SpriteData, Map<number, HTMLCanvasElement>>();

export function renderSpriteToCanvas(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let zoomMap = cache.get(sprite);
  if (!zoomMap) {
    zoomMap = new Map();
    cache.set(sprite, zoomMap);
  }
  const cached = zoomMap.get(zoom);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = sprite[0]?.length ?? 0;
  const canvas = document.createElement('canvas');
  canvas.width = cols * zoom;
  canvas.height = rows * zoom;
  zoomMap.set(zoom, canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = sprite[r][c];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
    }
  }

  return canvas;
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  x: number,
  y: number,
  zoom: number,
  flipH = false,
): void {
  const cached = renderSpriteToCanvas(sprite, zoom);
  if (flipH) {
    ctx.save();
    ctx.translate(x + cached.width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(cached, 0, 0);
    ctx.restore();
  } else {
    ctx.drawImage(cached, x, y);
  }
}

/** Recolor a sprite by mapping old colors to new colors */
export function recolorSprite(sprite: SpriteData, colorMap: Record<string, string>): SpriteData {
  return sprite.map((row) => row.map((c) => colorMap[c] ?? c));
}
