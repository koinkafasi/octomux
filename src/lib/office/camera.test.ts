import { describe, it, expect } from '../../bun-test.js';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerCamera,
  createCamera,
  followCharacter,
  panCamera,
  screenToGrid,
  zoomCamera,
} from './camera.js';
import { createCharacter } from './characters.js';
import { TILE_SIZE } from './types.js';
import type { Camera } from './types.js';

const at = (x: number, y: number, zoom = 2): Camera => ({ x, y, zoom });

describe('createCamera', () => {
  it('centres on the middle of the map at the default size', () => {
    expect(createCamera()).toEqual({ x: 24 * 16, y: 18 * 16, zoom: 2 });
  });

  it('scales with zoom', () => {
    expect(createCamera(10, 10, 4)).toEqual({ x: 320, y: 320, zoom: 4 });
  });
});

describe('centerCamera', () => {
  it('offsets the map centre by half the canvas', () => {
    // map is 10 * 16 * 2 = 320 wide; a 320-wide canvas needs no offset
    expect(centerCamera(10, 10, 320, 320, 2)).toEqual({ x: 0, y: 0, zoom: 2 });
  });

  it('goes negative when the canvas is larger than the map', () => {
    const cam = centerCamera(10, 10, 640, 640, 2);
    expect(cam.x).toBe(-160);
    expect(cam.y).toBe(-160);
  });
});

describe('panCamera', () => {
  it('adds the delta without mutating the input', () => {
    const original = at(100, 100);
    const panned = panCamera(original, 25, -10);
    expect(panned).toEqual({ x: 125, y: 90, zoom: 2 });
    expect(original).toEqual({ x: 100, y: 100, zoom: 2 });
  });

  it('preserves the follow target', () => {
    expect(panCamera({ ...at(0, 0), followTarget: 'x' }, 1, 1).followTarget).toBe('x');
  });
});

describe('zoomCamera', () => {
  it.each([
    [1, 1, 2],
    [2, 1, 3],
    [3, 1, 4],
    [4, 1, MAX_ZOOM], // clamped at the top
    [4, -1, 3],
    [2, -1, 1],
    [1, -1, MIN_ZOOM], // clamped at the bottom
  ] as Array<[number, 1 | -1, number]>)(
    'zoom %i with direction %i clamps to %i',
    (zoom, direction, expected) => {
      expect(zoomCamera(at(0, 0, zoom), direction).zoom).toBe(expected);
    },
  );

  it('leaves the position alone', () => {
    const cam = zoomCamera(at(50, 60, 2), 1);
    expect([cam.x, cam.y]).toEqual([50, 60]);
  });
});

describe('followCharacter', () => {
  it('moves a tenth of the way toward the character each call', () => {
    const character = createCharacter('a', 0, 10, 10);
    const cam = followCharacter(at(0, 0), character, 200, 200);
    // target = 160 * 2 - 100 + 16 = 236 → 0 + 236 * 0.1
    expect(cam.x).toBeCloseTo(23.6, 6);
    expect(cam.y).toBeCloseTo(23.6, 6);
  });

  it('converges on the target when applied repeatedly', () => {
    const character = createCharacter('a', 0, 10, 10);
    let cam = at(0, 0);
    for (let i = 0; i < 200; i++) cam = followCharacter(cam, character, 200, 200);
    expect(cam.x).toBeCloseTo(236, 3);
  });

  it('is a no-op once already on target', () => {
    const character = createCharacter('a', 0, 10, 10);
    const settled = at(236, 236);
    expect(followCharacter(settled, character, 200, 200)).toEqual(settled);
  });
});

describe('screenToGrid', () => {
  it('inverts the camera offset and zoom', () => {
    expect(screenToGrid(at(0, 0, 1), 0, 0)).toEqual({ x: 0, y: 0 });
    expect(screenToGrid(at(0, 0, 1), TILE_SIZE, TILE_SIZE)).toEqual({ x: 1, y: 1 });
    expect(screenToGrid(at(0, 0, 2), TILE_SIZE, TILE_SIZE)).toEqual({ x: 0, y: 0 });
    expect(screenToGrid(at(0, 0, 2), TILE_SIZE * 2, TILE_SIZE * 2)).toEqual({ x: 1, y: 1 });
  });

  it('accounts for a scrolled camera', () => {
    expect(screenToGrid(at(320, 160, 2), 0, 0)).toEqual({ x: 10, y: 5 });
  });

  it('floors toward negative infinity outside the map', () => {
    expect(screenToGrid(at(0, 0, 1), -1, -1)).toEqual({ x: -1, y: -1 });
  });

  it('round-trips a tile origin back to its own coordinates', () => {
    const camera = at(48, 96, 3);
    for (const [gx, gy] of [
      [0, 0],
      [4, 7],
      [12, 3],
    ]) {
      const screenX = gx * TILE_SIZE * camera.zoom - camera.x;
      const screenY = gy * TILE_SIZE * camera.zoom - camera.y;
      expect(screenToGrid(camera, screenX, screenY)).toEqual({ x: gx, y: gy });
    }
  });
});
