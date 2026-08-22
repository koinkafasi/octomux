/**
 * Public surface of the pixel-art office canvas engine.
 *
 * Every module under `src/lib/office/` is framework-free: it imports nothing but the DOM's
 * canvas types and its own siblings. React bindings live outside this directory.
 *
 * `sprite-data.ts` is deliberately NOT re-exported here. It is ~39 KB of literal pixel data
 * built at module-evaluation time, and `assets.ts` — which draws everything procedurally —
 * is what the renderer actually uses. Import it explicitly (`./sprite-data.js`) if you want
 * the pixel sprites, so nothing pulls the payload in by accident.
 *
 * See ./NOTICE for the upstream attribution and license.
 */

export * from './types.js';
export * from './tile-map.js';
export * from './camera.js';
export * from './sprites.js';
export * from './characters.js';
export * from './character-sync.js';
export * from './layout.js';
export * from './render-policy.js';
export * from './renderer.js';
export * from './lighting.js';
export * from './particles.js';
export * from './assets.js';
