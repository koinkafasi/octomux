/**
 * Ported from agora-lab (https://github.com/LiXin97/agora-lab),
 * packages/web/src/engine/layout.ts.
 * Copyright the agora-lab authors. Licensed under the Apache License 2.0.
 * Modifications: the four hard-coded research-lab roles (`supervisor`, `research-staff`,
 * `student`, `paper-reviewer`) were replaced by three structural occupant groups
 * (`office`, `workspace`, `annex`), `DeskPosition.name` became `id`, and the two dead
 * backward-compat helpers (`getDeskPositions` / `getMeetingPositions`, which returned
 * hard-coded coordinates unrelated to the computed layout) plus the unused `WALL` constant
 * were dropped. All room geometry,
 * furniture placement and desk maths is byte-for-byte the upstream arithmetic.
 */

import type { Tile, FurnitureInstance } from './types.js';
import { createGrid } from './tile-map.js';

// Room geometry constants
const TOP_ROOM_H = 7; // smaller top rooms
const BREAK_ROOM_H = 5; // smaller break room
const DESK_SPACING_X = 4; // tighter desk spacing
const DESK_SPACING_Y = 3; // tighter desk spacing
const PRIVATE_OFFICE_W = 7;
const GAP_BETWEEN_BUILDINGS = 3; // narrow outdoor path
const ANNEX_BUILDING_W = 10;

/**
 * Where an occupant sits, expressed structurally rather than by domain role.
 *
 * - `office`   — the private office in the top-left corner. Only the first such occupant
 *                gets the desk; the room is drawn either way.
 * - `workspace`— the open-plan grid of desks in the middle of the main building.
 * - `annex`    — the separate building across the path. Its presence widens the map.
 */
export type OccupantGroup = 'office' | 'workspace' | 'annex';

export interface OccupantLayout {
  id: string;
  group: OccupantGroup;
}

export interface DeskPosition {
  id: string;
  x: number;
  y: number;
  chairX: number;
  chairY: number;
}

export interface OfficeLayout {
  grid: Tile[][];
  furniture: FurnitureInstance[];
  cols: number;
  rows: number;
  deskPositions: DeskPosition[];
  meetingPositions: Array<{ x: number; y: number }>;
}

function fillRect(grid: Tile[][], x: number, y: number, w: number, h: number, type: Tile) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (y + dy < grid.length && x + dx < grid[0].length) {
        grid[y + dy][x + dx] = { ...type };
      }
    }
  }
}

function addWalls(grid: Tile[][], x: number, y: number, w: number, h: number) {
  for (let dx = 0; dx < w; dx++) {
    grid[y][x + dx] = { type: 'wall', walkable: false };
    grid[y + h - 1][x + dx] = { type: 'wall', walkable: false };
  }
  for (let dy = 0; dy < h; dy++) {
    grid[y + dy][x] = { type: 'wall', walkable: false };
    grid[y + dy][x + w - 1] = { type: 'wall', walkable: false };
  }
}

function addDoor(grid: Tile[][], x: number, y: number) {
  grid[y][x] = { type: 'door', walkable: true };
}

export function createOfficeLayout(occupants: OccupantLayout[] = []): OfficeLayout {
  const workspaceOccupants = occupants.filter((o) => o.group === 'workspace');
  const annexOccupants = occupants.filter((o) => o.group === 'annex');
  const officeOccupant = occupants.find((o) => o.group === 'office');

  // Calculate workspace dimensions based on occupant count
  const workspaceCols = 3;
  const workspaceRows = Math.max(2, Math.ceil(workspaceOccupants.length / workspaceCols));
  const workspaceH = Math.max(6, workspaceRows * DESK_SPACING_Y + 3);

  // Main building dimensions
  const meetingW = 10;
  // Width must fit: private office + meeting on top, AND 3 desk columns + margins below
  const minTopW = PRIVATE_OFFICE_W + meetingW;
  const minWsW = 6 + workspaceCols * DESK_SPACING_X + 2; // left margin + desks + right margin
  const mainW = Math.max(minTopW, minWsW);
  // Meeting room expands to fill remaining space if workspace is wider
  const actualMeetingW = mainW - PRIVATE_OFFICE_W;
  const mainH = TOP_ROOM_H + workspaceH + BREAK_ROOM_H;

  // Annex building dimensions
  const annexRows = Math.max(1, Math.ceil(annexOccupants.length / 2));
  const annexH = Math.max(7, annexRows * 3 + 4);

  // Overall grid: main building + gap + annex
  const hasAnnex = annexOccupants.length > 0;
  const cols = hasAnnex ? mainW + GAP_BETWEEN_BUILDINGS + ANNEX_BUILDING_W : mainW + 2;
  const rows = Math.max(mainH, hasAnnex ? annexH + 4 : 0) + 2; // +2 for outdoor border

  // Start with outdoor/grass background
  const grid = createGrid(cols, rows, 'empty');
  const furniture: FurnitureInstance[] = [];
  const deskPositions: DeskPosition[] = [];

  // === Outdoor ground (path between buildings) ===
  // Fill the gap area with a lighter ground tile to show it's a path
  if (hasAnnex) {
    fillRect(grid, mainW, 0, GAP_BETWEEN_BUILDINGS, rows, { type: 'floor_tile', walkable: true });
  }

  // ============================================================
  // MAIN BUILDING (left side) — outer walls first
  // ============================================================
  const mainX = 0;
  const mainY = 0;

  // Fill entire interior with floor, then add walls for the whole building
  fillRect(grid, mainX + 1, mainY + 1, mainW - 2, mainH - 2, {
    type: 'floor_wood',
    walkable: true,
  });
  addWalls(grid, mainX, mainY, mainW, mainH);

  // === PRIVATE OFFICE (top-left) ===
  const offX = mainX;
  const offY = mainY;
  fillRect(grid, offX + 1, offY + 1, PRIVATE_OFFICE_W - 2, TOP_ROOM_H - 2, {
    type: 'floor_dark_wood',
    walkable: true,
  });
  // Interior walls for the private office (right + bottom walls inside the building)
  for (let y = offY; y < offY + TOP_ROOM_H; y++) {
    grid[y][offX + PRIVATE_OFFICE_W - 1] = { type: 'wall', walkable: false };
  }
  for (let x = offX; x < offX + PRIVATE_OFFICE_W; x++) {
    grid[offY + TOP_ROOM_H - 1][x] = { type: 'wall', walkable: false };
  }
  addDoor(grid, offX + PRIVATE_OFFICE_W - 1, offY + 3);

  furniture.push({ type: 'desk', x: offX + 2, y: offY + 1, width: 2, height: 1 });
  furniture.push({ type: 'monitor', x: offX + 2, y: offY + 1, width: 1, height: 1 });
  furniture.push({ type: 'chair', x: offX + 3, y: offY + 2, width: 1, height: 1 });
  furniture.push({ type: 'bookshelf', x: offX + 1, y: offY + 4, width: 1, height: 1 });
  furniture.push({ type: 'plant', x: offX + 5, y: offY + 1, width: 1, height: 1 });
  if (officeOccupant) {
    deskPositions.push({
      id: officeOccupant.id,
      x: offX + 3,
      y: offY + 2,
      chairX: offX + 3,
      chairY: offY + 2,
    });
  }

  // === MEETING ROOM (top-right of main building) ===
  const meetX = PRIVATE_OFFICE_W;
  const meetY = mainY;
  fillRect(grid, meetX, meetY + 1, actualMeetingW - 1, TOP_ROOM_H - 2, {
    type: 'floor_tile',
    walkable: true,
  });
  // Bottom partition wall of meeting room
  for (let x = meetX; x < mainW; x++) {
    grid[meetY + TOP_ROOM_H - 1][x] = { type: 'wall', walkable: false };
  }
  addDoor(grid, meetX + Math.floor(actualMeetingW / 2), meetY + TOP_ROOM_H - 1);

  furniture.push({
    type: 'round_table',
    x: meetX + 3,
    y: meetY + 2,
    width: 2,
    height: 2,
    interactive: 'meeting',
  });
  furniture.push({
    type: 'projector',
    x: meetX + 2,
    y: meetY + 1,
    width: 3,
    height: 1,
    interactive: 'meeting',
  });
  const meetChairPositions = [
    { x: meetX + 2, y: meetY + 2 },
    { x: meetX + 5, y: meetY + 2 },
    { x: meetX + 2, y: meetY + 4 },
    { x: meetX + 5, y: meetY + 4 },
    { x: meetX + 3, y: meetY + 5 },
    { x: meetX + 4, y: meetY + 5 },
  ];
  for (const pos of meetChairPositions) {
    furniture.push({ type: 'chair', x: pos.x, y: pos.y, width: 1, height: 1 });
  }

  // === MAIN WORKSPACE (middle section) ===
  // Floor already set by the whole-building fill. Just add partition wall at bottom.
  const wsX = mainX;
  const wsY = TOP_ROOM_H;
  const wsW = mainW;
  const wsH = workspaceH;
  // Bottom partition wall between workspace and break room
  for (let x = wsX + 1; x < wsX + wsW - 1; x++) {
    grid[wsY + wsH - 1][x] = { type: 'wall', walkable: false };
  }

  // Whiteboard — tagged interactive so the host app can hang a board overlay off it
  furniture.push({
    type: 'whiteboard',
    x: wsX + 2,
    y: wsY + 1,
    width: 3,
    height: 1,
    interactive: 'board',
  });

  // Open-plan desks
  let wsIdx = 0;
  for (let row = 0; row < workspaceRows; row++) {
    for (let col = 0; col < workspaceCols && wsIdx < workspaceOccupants.length; col++) {
      const dx = wsX + 6 + col * DESK_SPACING_X;
      const dy = wsY + 2 + row * DESK_SPACING_Y;
      if (dx + 2 < wsW - 1 && dy + 2 < wsY + wsH - 1) {
        furniture.push({ type: 'desk', x: dx, y: dy, width: 2, height: 1 });
        furniture.push({ type: 'monitor', x: dx, y: dy, width: 1, height: 1 });
        furniture.push({ type: 'chair', x: dx + 1, y: dy + 1, width: 1, height: 1 });
        deskPositions.push({
          id: workspaceOccupants[wsIdx].id,
          x: dx + 1,
          y: dy + 1,
          chairX: dx + 1,
          chairY: dy + 1,
        });
      }
      wsIdx++;
    }
  }

  furniture.push({ type: 'plant', x: wsX + 1, y: wsY + 1, width: 1, height: 1 });
  furniture.push({ type: 'plant', x: wsW - 2, y: wsY + 1, width: 1, height: 1 });

  // === BREAK ROOM (bottom) ===
  // Override floor to carpet
  const brX = mainX;
  const brY = TOP_ROOM_H + wsH;
  const brW = mainW;
  const brH = BREAK_ROOM_H;
  fillRect(grid, brX + 1, brY, brW - 2, brH - 2, { type: 'floor_carpet', walkable: true });
  // Door in partition wall between workspace and break room
  addDoor(grid, brX + Math.floor(brW / 2), brY - 1);

  furniture.push({ type: 'coffee_machine', x: brX + 2, y: brY + 1, width: 1, height: 1 });
  furniture.push({ type: 'sofa', x: brX + 5, y: brY + 1, width: 2, height: 1 });
  furniture.push({ type: 'plant', x: brX + 4, y: brY + 1, width: 1, height: 1 });
  furniture.push({ type: 'plant', x: brX + 8, y: brY + 1, width: 1, height: 1 });
  // Exit door on right wall
  addDoor(grid, mainW - 1, brY + 2);

  // ============================================================
  // ANNEX BUILDING (right side, separate building)
  // ============================================================
  if (hasAnnex) {
    const anxX = mainW + GAP_BETWEEN_BUILDINGS;
    const anxY = 2; // slight offset from top for visual interest
    const anxW = ANNEX_BUILDING_W;
    const anxH = annexH;

    fillRect(grid, anxX + 1, anxY + 1, anxW - 2, anxH - 2, {
      type: 'floor_carpet',
      walkable: true,
    });
    addWalls(grid, anxX, anxY, anxW, anxH);
    // Door on left wall (facing the path)
    addDoor(grid, anxX, anxY + Math.floor(anxH / 2));

    // Decoration
    furniture.push({ type: 'bookshelf', x: anxX + anxW - 2, y: anxY + 1, width: 1, height: 2 });
    furniture.push({ type: 'plant', x: anxX + 1, y: anxY + anxH - 3, width: 1, height: 2 });

    // Annex desks — 2 columns
    let anxIdx = 0;
    for (let ri = 0; ri < annexRows; ri++) {
      for (let ci = 0; ci < 2 && anxIdx < annexOccupants.length; ci++) {
        const dx = anxX + 2 + ci * 4;
        const dy = anxY + 2 + ri * 3;
        furniture.push({ type: 'desk', x: dx, y: dy, width: 2, height: 1 });
        furniture.push({ type: 'monitor', x: dx, y: dy, width: 1, height: 1 });
        furniture.push({ type: 'chair', x: dx + 1, y: dy + 1, width: 1, height: 1 });
        deskPositions.push({
          id: annexOccupants[anxIdx].id,
          x: dx + 1,
          y: dy + 1,
          chairX: dx + 1,
          chairY: dy + 1,
        });
        anxIdx++;
      }
    }
  }

  // Make the outdoor path walkable between the two buildings
  if (hasAnnex) {
    const pathY = 2 + Math.floor(annexH / 2); // align with annex door
    // Walkable path from main-building exit to the annex
    for (let x = mainW - 1; x <= mainW + GAP_BETWEEN_BUILDINGS; x++) {
      for (let dy = -1; dy <= 1; dy++) {
        const py = pathY + dy;
        if (py >= 0 && py < rows && x >= 0 && x < cols) {
          if (grid[py][x].type === 'empty') {
            grid[py][x] = { type: 'floor_tile', walkable: true };
          }
        }
      }
    }
    // Also put a door in the main building's right wall at this path level
    if (pathY >= TOP_ROOM_H && pathY < TOP_ROOM_H + workspaceH - 1) {
      addDoor(grid, mainW - 1, pathY);
    }
  }

  return {
    grid,
    furniture,
    cols,
    rows,
    deskPositions,
    meetingPositions: meetChairPositions,
  };
}
