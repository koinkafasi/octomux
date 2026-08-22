import { describe, it, expect } from '../../bun-test.js';
import {
  bubbleSignature,
  characterSignature,
  needsAnimation,
  shouldRedraw,
  shouldRedrawCanvas,
} from './render-policy.js';
import type { RenderState, RenderViewport } from './render-policy.js';
import { createOfficeLayout } from './layout.js';
import { createCharacter } from './characters.js';
import type { Character, SpeechBubble } from './types.js';

const layout = createOfficeLayout([{ id: 'w-0', group: 'workspace' }]);

function baseState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    grid: layout.grid,
    furniture: layout.furniture,
    characters: [createCharacter('w-0', 0, 7, 10)],
    camera: { x: 0, y: 0, zoom: 2 },
    bubbles: [],
    selectedCharacterId: null,
    cols: layout.cols,
    rows: layout.rows,
    ...overrides,
  };
}

/** Same values, fresh object identities — what a React render produces every frame. */
function reRendered(state: RenderState): RenderState {
  return {
    ...state,
    characters: state.characters.map((c) => ({ ...c })),
    bubbles: state.bubbles.map((b) => ({ ...b })),
    camera: { ...state.camera },
  };
}

const bubble = (overrides: Partial<SpeechBubble> = {}): SpeechBubble => ({
  characterId: 'w-0',
  text: 'hello',
  style: 'status',
  createdAt: 1000,
  expiresAt: 5000,
  ...overrides,
});

const viewport: RenderViewport = { width: 800, height: 600, dpr: 2 };

describe('characterSignature', () => {
  it('is stable for an unchanged character', () => {
    const character = createCharacter('a', 0, 1, 1);
    expect(characterSignature(character)).toBe(characterSignature({ ...character }));
  });

  it.each([
    ['id', { id: 'other' }],
    ['state', { state: 'walk' }],
    ['direction', { direction: 'left' }],
    ['x', { x: 999 }],
    ['y', { y: 999 }],
    ['animFrame', { animFrame: 2 }],
    ['pathIndex', { pathIndex: 3 }],
    ['targetX', { targetX: 64 }],
    ['targetY', { targetY: 64 }],
  ] as Array<[string, Partial<Character>]>)('changes when %s changes', (_field, patch) => {
    const character = createCharacter('a', 0, 1, 1);
    expect(characterSignature({ ...character, ...patch })).not.toBe(characterSignature(character));
  });

  it.each([
    ['label', { label: 'renamed' }],
    ['paletteIndex', { paletteIndex: 4 }],
    ['animTimer', { animTimer: 137 }],
    ['deskX', { deskX: 12 }],
  ] as Array<[string, Partial<Character>]>)(
    'deliberately ignores %s (not observable in the frame)',
    (_field, patch) => {
      const character = createCharacter('a', 0, 1, 1);
      expect(characterSignature({ ...character, ...patch })).toBe(characterSignature(character));
    },
  );
});

describe('bubbleSignature', () => {
  it('is stable for identical bubbles', () => {
    expect(bubbleSignature(bubble())).toBe(bubbleSignature(bubble()));
  });

  it.each([
    ['characterId', { characterId: 'other' }],
    ['style', { style: 'critique' }],
    ['text', { text: 'different' }],
    ['createdAt', { createdAt: 2 }],
    ['expiresAt', { expiresAt: 2 }],
  ] as Array<[string, Partial<SpeechBubble>]>)('changes when %s changes', (_field, patch) => {
    expect(bubbleSignature(bubble(patch))).not.toBe(bubbleSignature(bubble()));
  });
});

describe('shouldRedraw', () => {
  it('always redraws the first frame', () => {
    expect(shouldRedraw(null, baseState())).toBe(true);
  });

  it('skips the redraw when nothing observable changed', () => {
    const previous = baseState();
    expect(shouldRedraw(previous, reRendered(previous))).toBe(false);
  });

  it('skips the redraw for brand-new character objects holding the same values', () => {
    const previous = baseState();
    const next = baseState({ characters: [createCharacter('w-0', 0, 7, 10)] });
    expect(shouldRedraw(previous, next)).toBe(false);
  });

  it.each([
    ['a character moved', (s: RenderState) => ({ characters: [{ ...s.characters[0], x: 1 }] })],
    [
      'a character changed state',
      (s: RenderState) => ({ characters: [{ ...s.characters[0], state: 'walk' as const }] }),
    ],
    [
      'a character turned',
      (s: RenderState) => ({ characters: [{ ...s.characters[0], direction: 'up' as const }] }),
    ],
    [
      'the animation frame advanced',
      (s: RenderState) => ({ characters: [{ ...s.characters[0], animFrame: 1 }] }),
    ],
    [
      'a character was added',
      (s: RenderState) => ({ characters: [...s.characters, createCharacter('b', 1, 0, 0)] }),
    ],
    ['a character was removed', () => ({ characters: [] })],
    ['the camera panned', (s: RenderState) => ({ camera: { ...s.camera, x: 4 } })],
    ['the camera zoomed', (s: RenderState) => ({ camera: { ...s.camera, zoom: 3 } })],
    ['the selection changed', () => ({ selectedCharacterId: 'w-0' })],
    ['the grid was rebuilt', () => ({ grid: createOfficeLayout([]).grid })],
    ['the furniture was rebuilt', () => ({ furniture: [...layout.furniture] })],
    ['the column count changed', () => ({ cols: 999 })],
    ['the row count changed', () => ({ rows: 999 })],
    ['ambient lighting toggled', () => ({ ambientLighting: true })],
    ['particles appeared', () => ({ particleCount: 3 })],
    ['the overlay changed', () => ({ overlayMode: 'board' })],
    ['a bubble appeared', () => ({ bubbles: [bubble()] })],
  ] as Array<[string, (s: RenderState) => Partial<RenderState>]>)(
    'redraws when %s',
    (_label, patch) => {
      const previous = baseState();
      const next = baseState(patch(previous));
      expect(shouldRedraw(previous, next)).toBe(true);
    },
  );

  it('redraws when a bubble is edited in place', () => {
    const previous = baseState({ bubbles: [bubble()] });
    const next = baseState({ bubbles: [bubble({ text: 'changed' })] });
    expect(shouldRedraw(previous, next)).toBe(true);
  });

  it('does not redraw when the bubbles are equal but freshly allocated', () => {
    const previous = baseState({ bubbles: [bubble()] });
    const next = baseState({ bubbles: [bubble()] });
    expect(shouldRedraw(previous, next)).toBe(false);
  });
});

describe('needsAnimation', () => {
  it('is false for a still scene', () => {
    expect(needsAnimation(baseState())).toBe(false);
  });

  it.each([['idle'], ['sitting'], ['meeting'], ['work']] as Array<[Character['state']]>)(
    'is false while a character is %s',
    (state) => {
      const character = { ...createCharacter('a', 0, 0, 0), state };
      expect(needsAnimation(baseState({ characters: [character] }))).toBe(false);
    },
  );

  it('is true while a character still has path steps left', () => {
    const character: Character = {
      ...createCharacter('a', 0, 0, 0),
      state: 'walk',
      path: [{ x: 1, y: 0 }],
      pathIndex: 0,
    };
    expect(needsAnimation(baseState({ characters: [character] }))).toBe(true);
  });

  it('is false once the path index has run past the end', () => {
    const character: Character = {
      ...createCharacter('a', 0, 0, 0),
      state: 'walk',
      path: [{ x: 1, y: 0 }],
      pathIndex: 1,
    };
    expect(needsAnimation(baseState({ characters: [character] }))).toBe(false);
  });

  it('is true for a walking character with no path and no target', () => {
    const character: Character = { ...createCharacter('a', 0, 0, 0), state: 'walk' };
    expect(needsAnimation(baseState({ characters: [character] }))).toBe(true);
  });

  it('is false for a walking character sitting exactly on its target', () => {
    const character: Character = {
      ...createCharacter('a', 0, 0, 0),
      state: 'walk',
      targetX: 0,
      targetY: 0,
    };
    expect(needsAnimation(baseState({ characters: [character] }))).toBe(false);
  });

  it('is true while particles are alive', () => {
    expect(needsAnimation(baseState({ particleCount: 1 }))).toBe(true);
  });
});

describe('shouldRedrawCanvas', () => {
  it('redraws on the first viewport', () => {
    expect(shouldRedrawCanvas(null, baseState(), null, viewport)).toBe(true);
  });

  it.each([
    ['width', { width: 801 }],
    ['height', { height: 601 }],
    ['dpr', { dpr: 1 }],
  ] as Array<[string, Partial<RenderViewport>]>)('redraws when the %s changed', (_f, patch) => {
    const previous = baseState();
    expect(
      shouldRedrawCanvas(previous, reRendered(previous), viewport, { ...viewport, ...patch }),
    ).toBe(true);
  });

  it('skips when both the viewport and the state are unchanged', () => {
    const previous = baseState();
    expect(shouldRedrawCanvas(previous, reRendered(previous), viewport, { ...viewport })).toBe(
      false,
    );
  });
});
