import { describe, it, expect } from '../../bun-test.js';
import { createGrid, isWalkable, findPath } from './tile-map.js';
import type { FurnitureInstance, Tile, TileType } from './types.js';

const NO_FURNITURE: FurnitureInstance[] = [];

function open(cols: number, rows: number): Tile[][] {
  return createGrid(cols, rows, 'floor_wood');
}

describe('createGrid', () => {
  it('builds a rows x cols grid', () => {
    const grid = createGrid(4, 3, 'floor_tile');
    expect(grid).toHaveLength(3);
    expect(grid[0]).toHaveLength(4);
  });

  it.each([
    ['floor_wood', true],
    ['floor_tile', true],
    ['floor_carpet', true],
    ['floor_dark_wood', true],
    ['door', true],
    ['wall', false],
    ['empty', false],
  ] as Array<[TileType, boolean]>)('marks %s walkable=%s', (type, walkable) => {
    const grid = createGrid(2, 2, type);
    expect(grid[0][0]).toEqual({ type, walkable });
  });

  it('gives every cell its own object', () => {
    const grid = createGrid(2, 2, 'floor_wood');
    grid[0][0].walkable = false;
    expect(grid[0][1].walkable).toBe(true);
    expect(grid[1][0].walkable).toBe(true);
  });

  it('handles a zero-sized grid', () => {
    expect(createGrid(0, 0, 'empty')).toEqual([]);
  });
});

describe('isWalkable', () => {
  const grid = open(5, 5);

  it.each([
    ['negative x', -1, 2],
    ['negative y', 2, -1],
    ['x past the right edge', 5, 2],
    ['y past the bottom edge', 2, 5],
  ])('rejects %s', (_label, x, y) => {
    expect(isWalkable(grid, x, y, NO_FURNITURE)).toBe(false);
  });

  it('accepts every in-bounds corner', () => {
    for (const [x, y] of [
      [0, 0],
      [4, 0],
      [0, 4],
      [4, 4],
    ]) {
      expect(isWalkable(grid, x, y, NO_FURNITURE)).toBe(true);
    }
  });

  it('rejects a non-walkable tile', () => {
    const walled = open(5, 5);
    walled[2][2] = { type: 'wall', walkable: false };
    expect(isWalkable(walled, 2, 2, NO_FURNITURE)).toBe(false);
  });

  it('rejects tiles covered by furniture, over the whole footprint', () => {
    const desk: FurnitureInstance = { type: 'desk', x: 1, y: 1, width: 2, height: 2 };
    expect(isWalkable(grid, 1, 1, [desk])).toBe(false);
    expect(isWalkable(grid, 2, 2, [desk])).toBe(false);
    // exclusive upper bound: x + width and y + height are clear again
    expect(isWalkable(grid, 3, 1, [desk])).toBe(true);
    expect(isWalkable(grid, 1, 3, [desk])).toBe(true);
  });

  it('lets characters walk over chairs', () => {
    const chair: FurnitureInstance = { type: 'chair', x: 1, y: 1, width: 1, height: 1 };
    expect(isWalkable(grid, 1, 1, [chair])).toBe(true);
  });
});

describe('findPath', () => {
  it('returns an empty path when already at the destination', () => {
    expect(findPath(open(5, 5), NO_FURNITURE, 2, 2, 2, 2)).toEqual([]);
  });

  it('excludes the start tile and includes the destination', () => {
    const path = findPath(open(5, 5), NO_FURNITURE, 0, 0, 3, 0);
    expect(path).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('finds a shortest 4-neighbour path (no diagonals)', () => {
    const path = findPath(open(5, 5), NO_FURNITURE, 0, 0, 2, 2);
    expect(path).not.toBeNull();
    expect(path).toHaveLength(4); // manhattan distance
    for (const step of path!) {
      expect(Number.isInteger(step.x) && Number.isInteger(step.y)).toBe(true);
    }
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 2 });
  });

  it('routes around blocking furniture', () => {
    const wall: FurnitureInstance = { type: 'bookshelf', x: 1, y: 0, width: 1, height: 4 };
    const path = findPath(open(5, 5), [wall], 0, 0, 3, 0);
    expect(path).not.toBeNull();
    for (const step of path!) {
      const inside = step.x === 1 && step.y >= 0 && step.y < 4;
      expect(inside).toBe(false);
    }
  });

  it('reaches a destination that itself sits on furniture', () => {
    // the destination tile is checked without furniture so a character can reach a desk
    const desk: FurnitureInstance = { type: 'desk', x: 3, y: 0, width: 1, height: 1 };
    const path = findPath(open(5, 5), [desk], 0, 0, 3, 0);
    expect(path?.[path.length - 1]).toEqual({ x: 3, y: 0 });
  });

  it('returns null when the destination is walled off', () => {
    const grid = open(5, 5);
    for (let y = 0; y < 5; y++) grid[y][2] = { type: 'wall', walkable: false };
    expect(findPath(grid, NO_FURNITURE, 0, 0, 4, 4)).toBeNull();
  });

  it('returns null for an out-of-bounds destination', () => {
    expect(findPath(open(5, 5), NO_FURNITURE, 0, 0, 9, 9)).toBeNull();
  });
});
