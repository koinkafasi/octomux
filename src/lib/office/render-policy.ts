/**
 * Ported from agora-lab (https://github.com/LiXin97/agora-lab),
 * packages/web/src/engine/render-policy.ts.
 * Copyright the agora-lab authors. Licensed under the Apache License 2.0.
 * Modifications: widened `RenderState.overlayMode` from the `'none' | 'kanban' | 'meeting'`
 * literal union to a free-form string, and exported `characterSignature` /
 * `bubbleSignature` so the dirty-check can be tested directly. The dirty-check itself —
 * the deliberate low-motion optimisation that skips a redraw when nothing observable
 * changed — is unchanged.
 */

import type { Camera, Character, FurnitureInstance, SpeechBubble, Tile } from './types.js';

export interface RenderState {
  grid: Tile[][];
  furniture: FurnitureInstance[];
  characters: Character[];
  camera: Camera;
  bubbles: SpeechBubble[];
  selectedCharacterId: string | null;
  cols: number;
  rows: number;
  ambientLighting?: boolean;
  particleCount?: number;
  /** Opaque to the engine; compared by identity to decide whether a redraw is needed. */
  overlayMode?: string;
}

export interface RenderViewport {
  width: number;
  height: number;
  dpr: number;
}

export function characterSignature(character: Character): string {
  return [
    character.id,
    character.state,
    character.direction,
    character.x,
    character.y,
    character.animFrame,
    character.pathIndex,
    character.targetX,
    character.targetY,
  ].join(':');
}

export function bubbleSignature(bubble: SpeechBubble): string {
  return [bubble.characterId, bubble.style, bubble.text, bubble.createdAt, bubble.expiresAt].join(
    ':',
  );
}

function cameraChanged(previous: Camera, next: Camera): boolean {
  return previous.x !== next.x || previous.y !== next.y || previous.zoom !== next.zoom;
}

function viewportChanged(previous: RenderViewport | null, next: RenderViewport): boolean {
  if (!previous) {
    return true;
  }

  return (
    previous.width !== next.width || previous.height !== next.height || previous.dpr !== next.dpr
  );
}

function collectionChanged<T>(
  previous: T[],
  next: T[],
  getSignature: (item: T) => string,
): boolean {
  if (previous.length !== next.length) {
    return true;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (getSignature(previous[index]) !== getSignature(next[index])) {
      return true;
    }
  }

  return false;
}

function isCharacterMoving(character: Character): boolean {
  if (character.state !== 'walk') {
    return false;
  }

  if (character.path && character.pathIndex !== undefined) {
    return character.pathIndex < character.path.length;
  }

  if (character.targetX === undefined || character.targetY === undefined) {
    return true;
  }

  return character.x !== character.targetX || character.y !== character.targetY;
}

export function needsAnimation(state: RenderState): boolean {
  return state.characters.some(isCharacterMoving) || (state.particleCount ?? 0) > 0;
}

export function shouldRedraw(previous: RenderState | null, next: RenderState): boolean {
  if (!previous) {
    return true;
  }

  if (
    previous.grid !== next.grid ||
    previous.furniture !== next.furniture ||
    previous.cols !== next.cols ||
    previous.rows !== next.rows ||
    previous.selectedCharacterId !== next.selectedCharacterId ||
    previous.ambientLighting !== next.ambientLighting ||
    previous.particleCount !== next.particleCount ||
    previous.overlayMode !== next.overlayMode ||
    cameraChanged(previous.camera, next.camera)
  ) {
    return true;
  }

  if (collectionChanged(previous.characters, next.characters, characterSignature)) {
    return true;
  }

  if (collectionChanged(previous.bubbles, next.bubbles, bubbleSignature)) {
    return true;
  }

  return false;
}

export function shouldRedrawCanvas(
  previousState: RenderState | null,
  nextState: RenderState,
  previousViewport: RenderViewport | null,
  nextViewport: RenderViewport,
): boolean {
  return viewportChanged(previousViewport, nextViewport) || shouldRedraw(previousState, nextState);
}
