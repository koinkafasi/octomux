import { describe, it, expect } from '../../bun-test.js';
import { createOfficeLayout } from './layout.js';
import type { OccupantGroup, OccupantLayout } from './layout.js';
import { isWalkable } from './tile-map.js';

/** The main building is a fixed 20 wide: max(PRIVATE_OFFICE_W + 10, 6 + 3 * 4 + 2). */
const MAIN_W = 20;

function occupants(group: OccupantGroup, count: number, prefix: string = group): OccupantLayout[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, group }));
}

describe('createOfficeLayout — grid dimensions', () => {
  it('builds a layout with no occupants at all', () => {
    const layout = createOfficeLayout();
    expect(layout.cols).toBe(MAIN_W + 2);
    expect(layout.grid).toHaveLength(layout.rows);
    expect(layout.grid[0]).toHaveLength(layout.cols);
    expect(layout.deskPositions).toEqual([]);
  });

  it.each([
    // [workspace count, expected rows] — workspaceRows = max(2, ceil(n / 3))
    [0, 23],
    [3, 23],
    [6, 23],
    [7, 26],
    [10, 29],
  ])('grows vertically with %i workspace occupants → %i rows', (count, expectedRows) => {
    const layout = createOfficeLayout(occupants('workspace', count));
    expect(layout.rows).toBe(expectedRows);
    expect(layout.cols).toBe(MAIN_W + 2);
  });

  it('widens the map to fit an annex building', () => {
    const withAnnex = createOfficeLayout(occupants('annex', 2));
    const without = createOfficeLayout(occupants('workspace', 2));
    expect(withAnnex.cols).toBe(MAIN_W + 3 + 10);
    expect(without.cols).toBe(MAIN_W + 2);
  });

  it('keeps every row the same width', () => {
    const layout = createOfficeLayout([
      ...occupants('office', 1),
      ...occupants('workspace', 5),
      ...occupants('annex', 3),
    ]);
    for (const row of layout.grid) {
      expect(row).toHaveLength(layout.cols);
    }
  });

  it('is deterministic for the same input', () => {
    const input = [...occupants('office', 1), ...occupants('workspace', 4)];
    expect(createOfficeLayout(input)).toEqual(createOfficeLayout(input));
  });
});

describe('createOfficeLayout — desk assignment', () => {
  it('gives the private office desk to the first office occupant only', () => {
    const layout = createOfficeLayout([
      { id: 'a', group: 'office' },
      { id: 'b', group: 'office' },
    ]);
    expect(layout.deskPositions).toEqual([{ id: 'a', x: 3, y: 2, chairX: 3, chairY: 2 }]);
  });

  it('lays workspace desks out left to right, then top to bottom', () => {
    const layout = createOfficeLayout(occupants('workspace', 4, 'w'));
    expect(layout.deskPositions).toEqual([
      { id: 'w-0', x: 7, y: 10, chairX: 7, chairY: 10 },
      { id: 'w-1', x: 11, y: 10, chairX: 11, chairY: 10 },
      { id: 'w-2', x: 15, y: 10, chairX: 15, chairY: 10 },
      { id: 'w-3', x: 7, y: 13, chairX: 7, chairY: 13 },
    ]);
  });

  it('places annex desks inside the annex building', () => {
    const layout = createOfficeLayout(occupants('annex', 2, 'a'));
    expect(layout.deskPositions).toEqual([
      { id: 'a-0', x: 26, y: 5, chairX: 26, chairY: 5 },
      { id: 'a-1', x: 30, y: 5, chairX: 30, chairY: 5 },
    ]);
  });

  it.each([
    [1, 1],
    [3, 3],
    [6, 6],
    [9, 9],
    [12, 12],
  ])('seats all %i workspace occupants (expects %i desks)', (count, expected) => {
    const layout = createOfficeLayout(occupants('workspace', count));
    expect(layout.deskPositions).toHaveLength(expected);
  });

  it('keeps desk ids unique and matched to their occupants', () => {
    const people = [
      ...occupants('office', 1, 'o'),
      ...occupants('workspace', 5, 'w'),
      ...occupants('annex', 3, 'a'),
    ];
    const layout = createOfficeLayout(people);
    const ids = layout.deskPositions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(people.some((p) => p.id === id)).toBe(true);
    }
  });

  it('puts every desk chair on a walkable tile', () => {
    const layout = createOfficeLayout([
      ...occupants('office', 1, 'o'),
      ...occupants('workspace', 6, 'w'),
      ...occupants('annex', 4, 'a'),
    ]);
    expect(layout.deskPositions.length).toBeGreaterThan(0);
    for (const desk of layout.deskPositions) {
      expect(isWalkable(layout.grid, desk.chairX, desk.chairY, [])).toBe(true);
    }
  });

  it('places no desks when the only occupants are unseated groups', () => {
    expect(createOfficeLayout(occupants('workspace', 0)).deskPositions).toEqual([]);
  });
});

describe('createOfficeLayout — rooms and furniture', () => {
  it('walls the outer edge of the main building', () => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    expect(layout.grid[0][0].type).toBe('wall');
    expect(layout.grid[0][MAIN_W - 1].type).toBe('wall');
    expect(layout.grid[0][0].walkable).toBe(false);
  });

  it.each([
    ['private office door', 6, 3],
    ['meeting room door', 13, 6],
    ['break room door', 10, 15],
    ['break room exit', 19, 18],
  ])('cuts a walkable %s at (%i, %i)', (_label, x, y) => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    expect(layout.grid[y][x]).toEqual({ type: 'door', walkable: true });
  });

  it('floors the private office in dark wood and the break room in carpet', () => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    expect(layout.grid[1][1].type).toBe('floor_dark_wood');
    expect(layout.grid[17][2].type).toBe('floor_carpet');
  });

  it('returns six meeting seats around the round table', () => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    expect(layout.meetingPositions).toEqual([
      { x: 9, y: 2 },
      { x: 12, y: 2 },
      { x: 9, y: 4 },
      { x: 12, y: 4 },
      { x: 10, y: 5 },
      { x: 11, y: 5 },
    ]);
  });

  it('puts a chair on every meeting seat', () => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    for (const seat of layout.meetingPositions) {
      const chair = layout.furniture.find(
        (f) => f.type === 'chair' && f.x === seat.x && f.y === seat.y,
      );
      expect(chair).toBeDefined();
    }
  });

  it('tags the interactive furniture with free-form strings, not domain names', () => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    const tags = layout.furniture.filter((f) => f.interactive).map((f) => f.interactive);
    expect(new Set(tags)).toEqual(new Set(['board', 'meeting']));
  });

  it('emits one desk, monitor and chair per seated occupant plus the private office set', () => {
    const layout = createOfficeLayout([
      ...occupants('office', 1, 'o'),
      ...occupants('workspace', 3, 'w'),
    ]);
    const desks = layout.furniture.filter((f) => f.type === 'desk');
    const monitors = layout.furniture.filter((f) => f.type === 'monitor');
    expect(desks).toHaveLength(4);
    expect(monitors).toHaveLength(4);
  });

  it('adds annex furniture only when the annex exists', () => {
    const without = createOfficeLayout(occupants('workspace', 3));
    const withAnnex = createOfficeLayout([...occupants('workspace', 3), ...occupants('annex', 2)]);
    expect(withAnnex.furniture.length).toBeGreaterThan(without.furniture.length);
  });

  it('keeps every furniture item inside the grid', () => {
    const layout = createOfficeLayout([
      ...occupants('office', 1, 'o'),
      ...occupants('workspace', 7, 'w'),
      ...occupants('annex', 4, 'a'),
    ]);
    for (const f of layout.furniture) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.width).toBeLessThanOrEqual(layout.cols);
      expect(f.y + f.height).toBeLessThanOrEqual(layout.rows);
    }
  });
});

describe('createOfficeLayout — outdoor path', () => {
  it('lays a walkable tile path in the gap between the buildings', () => {
    const layout = createOfficeLayout(occupants('annex', 2));
    // annexH = 7 → pathY = 2 + 3 = 5
    for (let x = MAIN_W; x < MAIN_W + 3; x++) {
      expect(layout.grid[5][x].walkable).toBe(true);
    }
  });

  it('opens the annex door on the wall facing the path', () => {
    const layout = createOfficeLayout(occupants('annex', 2));
    expect(layout.grid[5][MAIN_W + 3]).toEqual({ type: 'door', walkable: true });
  });

  it('leaves no gap column when there is no annex', () => {
    const layout = createOfficeLayout(occupants('workspace', 3));
    expect(layout.grid[5][MAIN_W].type).toBe('empty');
  });
});
