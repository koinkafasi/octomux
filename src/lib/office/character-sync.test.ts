import { describe, it, expect } from '../../bun-test.js';
import { syncCharactersToOccupants } from './character-sync.js';
import type { OccupantActivity, OccupantSnapshot } from './character-sync.js';
import { createOfficeLayout } from './layout.js';
import type { OfficeLayout } from './layout.js';
import { createCharacter } from './characters.js';
import { TILE_SIZE } from './types.js';
import type { Character } from './types.js';

const PEOPLE = [
  { id: 'boss', group: 'office' as const },
  { id: 'w-0', group: 'workspace' as const },
  { id: 'w-1', group: 'workspace' as const },
];

const layout: OfficeLayout = createOfficeLayout(PEOPLE);

function deskOf(id: string) {
  const desk = layout.deskPositions.find((d) => d.id === id);
  if (!desk) throw new Error(`no desk for ${id}`);
  return desk;
}

function snapshot(id: string, activity: OccupantActivity, label?: string): OccupantSnapshot {
  return { id, activity, label };
}

/** A character already seated on their own chair tile. */
function atDesk(id: string, overrides: Partial<Character> = {}): Character {
  const desk = deskOf(id);
  return { ...createCharacter(id, 0, desk.chairX, desk.chairY), ...overrides };
}

describe('syncCharactersToOccupants — spawning', () => {
  it('creates a character per occupant on the first sync', () => {
    const next = syncCharactersToOccupants(
      [],
      PEOPLE.map((p) => snapshot(p.id, 'available')),
      layout,
    );
    expect(next.map((c) => c.id)).toEqual(['boss', 'w-0', 'w-1']);
    expect(next.every((c) => c.state === 'idle')).toBe(true);
  });

  it('spawns each new character on their own desk chair', () => {
    const next = syncCharactersToOccupants([], [snapshot('w-1', 'available')], layout);
    const desk = deskOf('w-1');
    expect(next[0].x).toBe(desk.chairX * TILE_SIZE);
    expect(next[0].y).toBe(desk.chairY * TILE_SIZE);
    expect(next[0].deskX).toBe(desk.chairX);
    expect(next[0].deskY).toBe(desk.chairY);
  });

  it('falls back to (5, 5) for an occupant with no desk', () => {
    const next = syncCharactersToOccupants([], [snapshot('ghost', 'available')], layout);
    expect(next[0].x).toBe(5 * TILE_SIZE);
    expect(next[0].y).toBe(5 * TILE_SIZE);
    expect(next[0].deskX).toBeUndefined();
  });

  it('assigns palette indices by snapshot position', () => {
    const next = syncCharactersToOccupants(
      [],
      PEOPLE.map((p) => snapshot(p.id, 'away')),
      layout,
    );
    expect(next.map((c) => c.paletteIndex)).toEqual([0, 1, 2]);
  });

  it('carries the optional label through', () => {
    const next = syncCharactersToOccupants([], [snapshot('w-0', 'available', 'Ada')], layout);
    expect(next[0].label).toBe('Ada');
  });

  it('drops characters whose occupant disappeared', () => {
    const prev = [atDesk('w-0'), atDesk('w-1')];
    const next = syncCharactersToOccupants(prev, [snapshot('w-0', 'available')], layout);
    expect(next.map((c) => c.id)).toEqual(['w-0']);
  });

  it('preserves snapshot order, not previous order', () => {
    const prev = [atDesk('w-1'), atDesk('w-0')];
    const next = syncCharactersToOccupants(
      prev,
      [snapshot('w-0', 'away'), snapshot('w-1', 'away')],
      layout,
    );
    expect(next.map((c) => c.id)).toEqual(['w-0', 'w-1']);
  });
});

describe('syncCharactersToOccupants — busy', () => {
  it('sits a character that is already standing on its desk chair', () => {
    const next = syncCharactersToOccupants([atDesk('w-0')], [snapshot('w-0', 'busy')], layout);
    expect(next[0].state).toBe('sitting');
    expect(next[0].animFrame).toBe(0);
  });

  it('walks a character that is away from its desk', () => {
    const away = { ...createCharacter('w-0', 0, 2, 18), deskX: undefined, deskY: undefined };
    const next = syncCharactersToOccupants([away], [snapshot('w-0', 'busy')], layout);
    expect(next[0].state).toBe('walk');
    expect(next[0].path?.length).toBeGreaterThan(0);
    expect(next[0].targetX).toBe(deskOf('w-0').chairX * TILE_SIZE);
  });

  it('leaves an already-sitting character untouched', () => {
    const seated = atDesk('w-0', { state: 'sitting', animFrame: 2 });
    const next = syncCharactersToOccupants([seated], [snapshot('w-0', 'busy')], layout);
    expect(next[0]).toBe(seated);
  });

  it('does nothing for a busy occupant with no desk', () => {
    const wanderer = createCharacter('ghost', 0, 5, 5);
    const next = syncCharactersToOccupants([wanderer], [snapshot('ghost', 'busy')], layout);
    expect(next[0]).toBe(wanderer);
  });
});

describe('syncCharactersToOccupants — available', () => {
  it('stands a sitting character back up', () => {
    const seated = atDesk('w-0', { state: 'sitting' });
    const next = syncCharactersToOccupants([seated], [snapshot('w-0', 'available')], layout);
    expect(next[0].state).toBe('idle');
  });

  it('walks an idle character back to its desk', () => {
    const elsewhere = createCharacter('w-0', 0, 2, 18);
    const next = syncCharactersToOccupants([elsewhere], [snapshot('w-0', 'available')], layout);
    expect(next[0].state).toBe('walk');
  });

  it('leaves a character that is already idling at its desk alone', () => {
    const parked = atDesk('w-0');
    const next = syncCharactersToOccupants([parked], [snapshot('w-0', 'available')], layout);
    expect(next[0].state).toBe('idle');
    expect(next[0].x).toBe(parked.x);
  });
});

describe('syncCharactersToOccupants — gathering', () => {
  it('sends a character toward a meeting seat', () => {
    const next = syncCharactersToOccupants([atDesk('w-0')], [snapshot('w-0', 'gathering')], layout);
    expect(next[0].state).toBe('walk');
    const seat = layout.meetingPositions[0];
    expect(next[0].targetX).toBe(seat.x * TILE_SIZE);
    expect(next[0].targetY).toBe(seat.y * TILE_SIZE);
  });

  it('spreads attendees across the meeting seats by index', () => {
    const prev = PEOPLE.map((p) => atDesk(p.id));
    const next = syncCharactersToOccupants(
      prev,
      PEOPLE.map((p) => snapshot(p.id, 'gathering')),
      layout,
    );
    const targets = next.map((c) => c.targetX);
    expect(new Set(targets).size).toBeGreaterThan(1);
  });

  it('does not re-target a character already in the meeting state', () => {
    const meeting = atDesk('w-0', { state: 'meeting' });
    const next = syncCharactersToOccupants([meeting], [snapshot('w-0', 'gathering')], layout);
    expect(next[0]).toBe(meeting);
  });

  it('lets a busy occupant leave the meeting state for its desk', () => {
    const meeting = atDesk('w-0', { state: 'meeting' });
    const next = syncCharactersToOccupants([meeting], [snapshot('w-0', 'busy')], layout);
    expect(next[0].state).toBe('sitting');
  });
});

describe('syncCharactersToOccupants — away', () => {
  it.each([['walk'], ['sitting'], ['meeting'], ['work']] as Array<[Character['state']]>)(
    'stops a character in the %s state where it stands',
    (state) => {
      const moving = atDesk('w-0', { state, x: 99, y: 77 });
      const next = syncCharactersToOccupants([moving], [snapshot('w-0', 'away')], layout);
      expect(next[0].state).toBe('idle');
      expect([next[0].x, next[0].y]).toEqual([99, 77]);
    },
  );

  it('leaves an already-idle character identical', () => {
    const parked = atDesk('w-0');
    const next = syncCharactersToOccupants([parked], [snapshot('w-0', 'away')], layout);
    expect(next[0]).toBe(parked);
  });
});

describe('syncCharactersToOccupants — purity', () => {
  it('never mutates the previous characters', () => {
    const prev = PEOPLE.map((p) => atDesk(p.id));
    const before = JSON.parse(JSON.stringify(prev));
    syncCharactersToOccupants(
      prev,
      PEOPLE.map((p) => snapshot(p.id, 'gathering')),
      layout,
    );
    expect(JSON.parse(JSON.stringify(prev))).toEqual(before);
  });

  it('converges: re-syncing the same busy snapshot is idempotent', () => {
    const first = syncCharactersToOccupants([atDesk('w-0')], [snapshot('w-0', 'busy')], layout);
    const second = syncCharactersToOccupants(first, [snapshot('w-0', 'busy')], layout);
    expect(second[0]).toBe(first[0]);
  });
});
