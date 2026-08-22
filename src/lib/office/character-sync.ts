/**
 * Ported from agora-lab (https://github.com/LiXin97/agora-lab),
 * packages/web/src/engine/characterSync.ts.
 * Copyright the agora-lab authors. Licensed under the Apache License 2.0.
 * Modifications: dropped the `AgentRuntimeStatus` import from `@agora-lab/core` in favour of
 * a local four-value `OccupantActivity` union (upstream's six statuses collapsed pairwise
 * with no behaviour lost — see the table below), keyed snapshots by an explicit `id` instead
 * of reusing the display name as the identity, and replaced the hard-coded `/ 16` grid maths
 * with TILE_SIZE. The reconciliation rules and their order are otherwise unchanged.
 */

import { TILE_SIZE } from './types.js';
import type { Character } from './types.js';
import type { OfficeLayout } from './layout.js';
import { createCharacter, setCharacterTarget, setCharacterState } from './characters.js';

/**
 * What an occupant is doing, in engine terms. The host app maps its own status vocabulary
 * onto these four; the engine never sees the domain names.
 *
 * | activity    | behaviour                                    | upstream status     |
 * | ----------- | -------------------------------------------- | ------------------- |
 * | `gathering` | walk to a seat in the meeting room           | `meeting`           |
 * | `busy`      | walk to own desk, then sit (typing anim)     | `working`, `review` |
 * | `available` | stand at own desk, idle                      | `ready`, `assigned` |
 * | `away`      | stop where they are and idle                 | `offline`           |
 */
export type OccupantActivity = 'gathering' | 'busy' | 'available' | 'away';

export interface OccupantSnapshot {
  id: string;
  activity: OccupantActivity;
  /** Optional display name, carried onto the character as `label`. */
  label?: string;
}

/**
 * Pure function that reconciles a Character array against the current occupant snapshots.
 * Returns one character per snapshot, in snapshot order; characters whose id disappears
 * from the snapshot list are dropped.
 */
export function syncCharactersToOccupants(
  prev: Character[],
  occupants: OccupantSnapshot[],
  layout: OfficeLayout,
): Character[] {
  const existing = new Map(prev.map((c) => [c.id, c]));
  const deskMap = new Map(layout.deskPositions.map((d) => [d.id, d]));

  return occupants.map((occupant, i) => {
    const desk = deskMap.get(occupant.id);
    const deskX = desk?.chairX;
    const deskY = desk?.chairY;
    const current = existing.get(occupant.id);

    if (current) {
      const ch = current;

      // gathering → move to the meeting area
      if (occupant.activity === 'gathering' && ch.state !== 'meeting') {
        const pos = layout.meetingPositions[i % layout.meetingPositions.length];
        return setCharacterTarget(
          { ...ch, deskX, deskY },
          pos.x,
          pos.y,
          layout.grid,
          layout.furniture,
        );
      }

      // busy → sit at desk (also exits the meeting state)
      if (
        occupant.activity === 'busy' &&
        (ch.state === 'idle' || ch.state === 'walk' || ch.state === 'meeting')
      ) {
        if (deskX !== undefined && deskY !== undefined) {
          const refreshed = { ...ch, deskX, deskY };
          const atDesk =
            Math.floor(ch.x / TILE_SIZE) === deskX && Math.floor(ch.y / TILE_SIZE) === deskY;
          if (atDesk) return setCharacterState(refreshed, 'sitting');
          return setCharacterTarget(refreshed, deskX, deskY, layout.grid, layout.furniture);
        }
      }

      // available → walk to desk and idle there (also exits the meeting state)
      if (
        occupant.activity === 'available' &&
        (ch.state === 'idle' || ch.state === 'sitting' || ch.state === 'meeting')
      ) {
        const refreshed = { ...ch, deskX, deskY };
        if (ch.state === 'sitting') return setCharacterState(refreshed, 'idle');
        if (deskX !== undefined && deskY !== undefined) {
          const atDesk =
            Math.floor(ch.x / TILE_SIZE) === deskX && Math.floor(ch.y / TILE_SIZE) === deskY;
          if (!atDesk)
            return setCharacterTarget(refreshed, deskX, deskY, layout.grid, layout.furniture);
        }
      }

      // away → keep idle at the current position (no movement)
      if (occupant.activity === 'away' && ch.state !== 'idle') {
        return setCharacterState(ch, 'idle');
      }

      return ch;
    }

    const spawnX = deskX ?? 5;
    const spawnY = deskY ?? 5;
    return {
      ...createCharacter(occupant.id, i, spawnX, spawnY, occupant.label),
      deskX,
      deskY,
    };
  });
}
