import { describe, it, expect } from '../../bun-test.js';
import { TILE_SIZE, needsAnimation, type Character } from '@/lib/office';
import {
  agentsSignature,
  buildOfficeScene,
  characterStateForActivity,
  findCharacterAt,
  paletteIndexForKey,
  waitingBubbleText,
  type OfficeAgent,
} from './agents-to-characters.js';

function agent(overrides: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    key: 'task-1:0',
    taskId: 'task-1',
    windowIndex: 0,
    taskTitle: 'Fix the flaky poller test',
    agentName: 'Agent 1',
    activity: 'active',
    ...overrides,
  };
}

describe('characterStateForActivity', () => {
  it.each([
    ['active', 'work'],
    ['idle', 'sitting'],
    ['waiting', 'meeting'],
  ] as const)('maps %s to the %s pose', (activity, state) => {
    expect(characterStateForActivity(activity)).toBe(state);
  });

  it('never uses a pose that keeps the animation loop alive', () => {
    const scene = buildOfficeScene([
      agent({ key: 'a:0', activity: 'active' }),
      agent({ key: 'b:0', activity: 'idle' }),
      agent({ key: 'c:0', activity: 'waiting' }),
    ]);
    // `walk` is the only state `isCharacterMoving()` reports, and particles are unused.
    expect(scene.characters.some((c) => c.state === 'walk')).toBe(false);
    expect(
      needsAnimation({
        grid: scene.layout.grid,
        furniture: scene.layout.furniture,
        characters: scene.characters,
        camera: { x: 0, y: 0, zoom: 1 },
        bubbles: scene.bubbles,
        selectedCharacterId: null,
        cols: scene.layout.cols,
        rows: scene.layout.rows,
      }),
    ).toBe(false);
  });

  it.each([
    ['active', 1],
    ['idle', 0],
    ['waiting', 0],
  ] as const)('freezes %s on anim frame %i', (activity, frame) => {
    const [character] = buildOfficeScene([agent({ activity })]).characters;
    expect(character.animFrame).toBe(frame);
  });
});

describe('buildOfficeScene', () => {
  it('builds an empty room for no agents', () => {
    const scene = buildOfficeScene([]);
    expect(scene.characters).toEqual([]);
    expect(scene.bubbles).toEqual([]);
    expect(scene.layout.cols).toBeGreaterThan(0);
    expect(scene.layout.rows).toBeGreaterThan(0);
  });

  it('emits one character per agent, ordered by key', () => {
    const scene = buildOfficeScene([
      agent({ key: 'zz:1', agentName: 'Last' }),
      agent({ key: 'aa:0', agentName: 'First' }),
    ]);
    expect(scene.characters.map((c) => c.id)).toEqual(['aa:0', 'zz:1']);
    expect(scene.characters.map((c) => c.label)).toEqual(['First', 'Last']);
  });

  it('seats every agent on its own desk chair', () => {
    const agents = [
      agent({ key: 'a:0' }),
      agent({ key: 'b:0' }),
      agent({ key: 'c:0' }),
      agent({ key: 'd:0' }),
    ];
    const scene = buildOfficeScene(agents);
    const desks = new Map(scene.layout.deskPositions.map((d) => [d.id, d]));

    expect(desks.size).toBe(agents.length);
    for (const character of scene.characters) {
      const desk = desks.get(character.id);
      expect(desk).toBeDefined();
      expect(character.x).toBe(desk!.chairX * TILE_SIZE);
      expect(character.y).toBe(desk!.chairY * TILE_SIZE);
      expect(character.deskX).toBe(desk!.chairX);
      expect(character.deskY).toBe(desk!.chairY);
    }

    const seats = scene.characters.map((c) => `${c.x},${c.y}`);
    expect(new Set(seats).size).toBe(seats.length);
  });

  it('faces every character at the viewer so the eyes are drawn', () => {
    const scene = buildOfficeScene([agent({ key: 'a:0' }), agent({ key: 'b:0' })]);
    expect(scene.characters.every((c) => c.direction === 'down')).toBe(true);
  });

  it('gives a waiting agent a non-expiring speech bubble naming its task', () => {
    const waiting = agent({ key: 'x:0', activity: 'waiting', taskTitle: 'Ship the release' });
    const scene = buildOfficeScene([waiting]);

    expect(scene.bubbles).toHaveLength(1);
    const [bubble] = scene.bubbles;
    expect(bubble.characterId).toBe('x:0');
    expect(bubble.style).toBe('question');
    expect(bubble.text).toBe(waitingBubbleText(waiting));
    expect(bubble.text).toContain('Ship the release');
    // `render()` drops a bubble once Date.now() passes expiresAt.
    expect(bubble.expiresAt).toBeGreaterThan(Date.now());
    // Constant timestamps keep `bubbleSignature()` stable across rebuilds.
    expect(bubble.createdAt).toBe(0);
  });

  it.each([['active'], ['idle']] as const)('gives a %s agent no bubble', (activity) => {
    expect(buildOfficeScene([agent({ activity })]).bubbles).toEqual([]);
  });

  it('bubbles only the waiting agents in a mixed room', () => {
    const scene = buildOfficeScene([
      agent({ key: 'a:0', activity: 'active' }),
      agent({ key: 'b:0', activity: 'waiting' }),
      agent({ key: 'c:0', activity: 'idle' }),
      agent({ key: 'd:0', activity: 'waiting' }),
    ]);
    expect(scene.bubbles.map((b) => b.characterId)).toEqual(['b:0', 'd:0']);
  });

  it('produces field-identical output for the same agents', () => {
    const agents = [agent({ key: 'a:0' }), agent({ key: 'b:0', activity: 'waiting' })];
    const first = buildOfficeScene(agents);
    const second = buildOfficeScene(agents);
    expect(second.characters).toEqual(first.characters);
    expect(second.bubbles).toEqual(first.bubbles);
  });

  it('does not mutate the agent array it is handed', () => {
    const agents = [agent({ key: 'z:0' }), agent({ key: 'a:0' })];
    buildOfficeScene(agents);
    expect(agents.map((a) => a.key)).toEqual(['z:0', 'a:0']);
  });
});

describe('paletteIndexForKey', () => {
  it('is deterministic and non-negative', () => {
    expect(paletteIndexForKey('task-1:0')).toBe(paletteIndexForKey('task-1:0'));
    expect(paletteIndexForKey('task-1:0')).toBeGreaterThanOrEqual(0);
  });

  it('separates the agents of one task', () => {
    expect(paletteIndexForKey('task-1:0')).not.toBe(paletteIndexForKey('task-1:1'));
  });

  it('keeps an agent colour independent of its position in the list', () => {
    const first = buildOfficeScene([agent({ key: 'a:0' }), agent({ key: 'b:0' })]);
    const second = buildOfficeScene([agent({ key: 'b:0' })]);
    const a = first.characters.find((c) => c.id === 'b:0');
    const b = second.characters.find((c) => c.id === 'b:0');
    expect(a!.paletteIndex).toBe(b!.paletteIndex);
  });
});

describe('agentsSignature', () => {
  it('is stable across equal-but-distinct arrays', () => {
    expect(agentsSignature([agent()])).toBe(agentsSignature([agent()]));
  });

  it.each([
    ['activity', { activity: 'waiting' } as Partial<OfficeAgent>],
    ['agent name', { agentName: 'Renamed' } as Partial<OfficeAgent>],
    ['task title', { taskTitle: 'Renamed task' } as Partial<OfficeAgent>],
    ['key', { key: 'other:0' } as Partial<OfficeAgent>],
  ])('changes when the %s changes', (_label, overrides) => {
    expect(agentsSignature([agent(overrides)])).not.toBe(agentsSignature([agent()]));
  });

  it('changes when an agent appears or disappears', () => {
    expect(agentsSignature([agent(), agent({ key: 'b:0' })])).not.toBe(agentsSignature([agent()]));
  });
});

describe('findCharacterAt', () => {
  const characters: Character[] = buildOfficeScene([
    agent({ key: 'a:0' }),
    agent({ key: 'b:0' }),
  ]).characters;

  it('hits the tile the character stands on', () => {
    const [first] = characters;
    const gx = first.x / TILE_SIZE;
    const gy = first.y / TILE_SIZE;
    expect(findCharacterAt(characters, gx, gy)).toBe(first.id);
  });

  it('hits the tile below too — the sprite is two tiles tall', () => {
    const [first] = characters;
    expect(findCharacterAt(characters, first.x / TILE_SIZE, first.y / TILE_SIZE + 1)).toBe(
      first.id,
    );
  });

  it.each([
    ['empty floor', 0, 0],
    ['off the map', -5, -5],
  ])('returns null for %s', (_label, x, y) => {
    expect(findCharacterAt(characters, x, y)).toBeNull();
  });

  it('returns null when nobody is in the room', () => {
    expect(findCharacterAt([], 3, 3)).toBeNull();
  });
});
