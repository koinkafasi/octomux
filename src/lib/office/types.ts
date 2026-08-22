/**
 * Ported from agora-lab (https://github.com/LiXin97/agora-lab),
 * packages/web/src/engine/types.ts.
 * Copyright the agora-lab authors. Licensed under the Apache License 2.0.
 * Modifications: de-domained the Character shape (dropped the required `name`/`role` fields
 * for an optional `label`) and widened `FurnitureInstance.interactive` from the
 * `'kanban' | 'meeting'` literal union to a free-form tag string.
 */

export const TILE_SIZE = 16;

export type TileType =
  | 'floor_wood'
  | 'floor_tile'
  | 'floor_carpet'
  | 'floor_dark_wood'
  | 'wall'
  | 'door'
  | 'empty';

export interface Tile {
  type: TileType;
  walkable: boolean;
}

export type FurnitureType =
  | 'desk'
  | 'chair'
  | 'bookshelf'
  | 'whiteboard'
  | 'projector'
  | 'round_table'
  | 'coffee_machine'
  | 'plant'
  | 'door_frame'
  | 'monitor'
  | 'sofa';

export interface FurnitureInstance {
  type: FurnitureType;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Free-form tag marking this piece as clickable. The engine never interprets it — it
   * only carries the value through so the embedding app can key an overlay off it.
   */
  interactive?: string;
}

/** How a character is drawn/animated. Distinct from the caller's own domain status. */
export type CharacterState = 'idle' | 'walk' | 'work' | 'sitting' | 'meeting';

export type Direction = 'down' | 'up' | 'left' | 'right';

export interface Character {
  id: string;
  /** Optional display name. The engine only carries it; nothing renders it today. */
  label?: string;
  paletteIndex: number;
  state: CharacterState;
  direction: Direction;
  /** Pixel position (not grid position) — grid coords are `x / TILE_SIZE`. */
  x: number;
  y: number;
  targetX?: number;
  targetY?: number;
  path?: Array<{ x: number; y: number }>;
  pathIndex?: number;
  animFrame: number;
  animTimer: number;
  deskX?: number;
  deskY?: number;
}

export interface SpeechBubble {
  characterId: string;
  text: string;
  style: 'question' | 'decision' | 'critique' | 'status';
  expiresAt: number;
  createdAt: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  followTarget?: string;
}
