/**
 * Maps octomux's live agents onto the pixel-office engine's data shapes.
 *
 * Pure — no React, no DOM, no canvas. `OfficeCanvas` renders whatever this returns and
 * `render-policy`'s dirty check compares consecutive results field by field, so every value
 * produced here is a deterministic function of the agent list: same agents in, same states,
 * positions, palettes and bubbles out.
 *
 * Object *identity* is not stable across calls (a fresh layout grid is built every time), and
 * `shouldRedraw` compares `grid`/`furniture` by identity. Callers therefore keep the agent
 * array itself stable — see `agentsSignature` — and memoise the scene on it, so a poll that
 * changed nothing does not force a repaint.
 */

import type { HookActivity } from '@octomux/types';
import {
  createCharacter,
  createOfficeLayout,
  TILE_SIZE,
  type Character,
  type CharacterState,
  type OccupantLayout,
  type OfficeLayout,
  type SpeechBubble,
} from '@/lib/office';

/**
 * Structural mirror of `FlatAgent` in `src/lib/running-agents.ts`. Kept as a local shape
 * rather than an import so this mapping stays independent of octomux's task types; tsc
 * checks the two against each other at the call site, which passes `flattenRunningAgents(tasks)` straight
 * in, so tsc checks the two shapes against each other there.
 */
export interface OfficeAgent {
  key: string;
  taskId: string;
  windowIndex: number;
  taskTitle: string;
  agentName: string;
  activity: HookActivity;
}

export interface OfficeScene {
  layout: OfficeLayout;
  /** One character per agent, ordered by `key` so the dirty check can compare index by index. */
  characters: Character[];
  /** Only the agents that are blocked on a human get one. */
  bubbles: SpeechBubble[];
}

/**
 * octomux activity → engine pose.
 *
 * The engine has five poses but only three of them are both visually distinct *and* static,
 * which is what a low-motion board needs (`drawCharacter` in `assets.ts`):
 *
 * - `work`    — full standing body plus a work-gesture hand on odd anim frames. The only pose
 *               the engine draws a "doing something" gesture for.
 * - `sitting` — upper body only, shifted down 6px so it reads as seated at the desk; the
 *               typing hands only appear on odd anim frames, so at frame 0 it is the quietest
 *               silhouette in the set. That is what "alive but producing nothing" should look
 *               like, so `idle` maps here rather than to the engine's own `idle`.
 * - `meeting` — no special branch in `drawCharacter`: a plain standing body with no work
 *               gesture. Read as "stood up, away from the keyboard".
 *
 * Two poses are deliberately unused:
 *
 * - `idle` adds `Math.sin(Date.now() / 1000)` to the y offset. Harmless while nothing
 *   repaints, but it makes a frame's output depend on wall-clock time, which is exactly the
 *   ambient motion this view is supposed to avoid.
 * - `walk` makes `isCharacterMoving()` true, so `needsAnimation()` would keep the
 *   requestAnimationFrame loop running forever.
 */
const ACTIVITY_TO_STATE: Record<HookActivity, CharacterState> = {
  active: 'work',
  idle: 'sitting',
  waiting: 'meeting',
};

/**
 * Frozen animation frame per activity — nothing advances these, they are picked once so the
 * single static frame is the most legible one. `work` uses frame 1 because that is the frame
 * `drawCharacter` adds the work-gesture hand on; the resting poses use frame 0.
 */
const ACTIVITY_TO_ANIM_FRAME: Record<HookActivity, number> = {
  active: 1,
  idle: 0,
  waiting: 0,
};

/**
 * A bubble the renderer will never expire (`render()` skips a bubble once `Date.now()` is past
 * `expiresAt`). Both timestamps are constants rather than `Date.now()` so `bubbleSignature()`
 * is stable and rebuilding the scene does not look like a change.
 */
const BUBBLE_CREATED_AT = 0;
const BUBBLE_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

/** Only used if the layout somehow hands back no desk; every workspace occupant gets one. */
const FALLBACK_SPAWN_X = 1;
const FALLBACK_SPAWN_Y = 1;

export function characterStateForActivity(activity: HookActivity): CharacterState {
  return ACTIVITY_TO_STATE[activity];
}

/**
 * `waiting` means a permission prompt is on screen and nothing moves until a human answers it,
 * so it gets the one attention-grabbing affordance the engine has: a persistent speech bubble
 * in the `question` style (blue accent). The renderer truncates to 30 characters.
 */
export function waitingBubbleText(agent: OfficeAgent): string {
  return `needs you · ${agent.taskTitle}`;
}

/**
 * Stable colour per agent. The renderer takes `paletteIndex % CHARACTER_PALETTES.length`, so
 * any non-negative integer is valid; hashing the key (FNV-1a) rather than using the array index
 * keeps an agent's colour the same when other agents come and go.
 */
export function paletteIndexForKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Cheap value-equality key for an agent list. The page compares this across polls and keeps the
 * previous array when nothing changed, which keeps the memoised scene — and therefore the
 * canvas — untouched.
 */
export function agentsSignature(agents: readonly OfficeAgent[]): string {
  return agents
    .map((agent) => `${agent.key}|${agent.activity}|${agent.agentName}|${agent.taskTitle}`)
    .join('\n');
}

/**
 * Which character (if any) covers a grid cell. A character sprite is one tile wide and spans
 * its own row plus the one below it, which is why both rows count as a hit. Desks are three
 * rows apart, so the two-row boxes never overlap.
 */
export function findCharacterAt(
  characters: readonly Character[],
  gridX: number,
  gridY: number,
): string | null {
  for (const character of characters) {
    const cx = Math.floor(character.x / TILE_SIZE);
    const cy = Math.floor(character.y / TILE_SIZE);
    if (gridX === cx && (gridY === cy || gridY === cy + 1)) return character.id;
  }
  return null;
}

/**
 * Builds the whole scene from an agent list.
 *
 * Every agent is a `workspace` occupant: octomux's workers are peers (tmux windows in one
 * session), so the open-plan desk grid is the honest room for them. The engine's other two
 * groups are not used — `office` seats exactly one occupant in a private room, and `annex`
 * would split the roster across two buildings on a distinction octomux does not have.
 *
 * Characters are placed directly on their desk chair with a frozen pose. Nothing walks: the
 * engine's `syncCharactersToOccupants` would path them there over many frames, which is the
 * ambient motion this view deliberately does not have.
 */
export function buildOfficeScene(agents: readonly OfficeAgent[]): OfficeScene {
  const ordered = [...agents].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const occupants: OccupantLayout[] = ordered.map((agent) => ({
    id: agent.key,
    group: 'workspace',
  }));
  const layout = createOfficeLayout(occupants);
  const deskById = new Map(layout.deskPositions.map((desk) => [desk.id, desk]));

  const characters: Character[] = [];
  const bubbles: SpeechBubble[] = [];

  ordered.forEach((agent, index) => {
    const desk = deskById.get(agent.key);
    const gridX = desk?.chairX ?? FALLBACK_SPAWN_X + (index % 3);
    const gridY = desk?.chairY ?? FALLBACK_SPAWN_Y;

    characters.push({
      ...createCharacter(agent.key, paletteIndexForKey(agent.key), gridX, gridY, agent.agentName),
      state: characterStateForActivity(agent.activity),
      direction: 'down',
      animFrame: ACTIVITY_TO_ANIM_FRAME[agent.activity],
      deskX: desk?.chairX,
      deskY: desk?.chairY,
    });

    if (agent.activity === 'waiting') {
      bubbles.push({
        characterId: agent.key,
        text: waitingBubbleText(agent),
        style: 'question',
        createdAt: BUBBLE_CREATED_AT,
        expiresAt: BUBBLE_EXPIRES_AT,
      });
    }
  });

  return { layout, characters, bubbles };
}
