/**
 * Loader for declarative engine presets (spec/engine-layer.md §2.2, delivery
 * step 3).
 *
 * Reads every `*.json` under `server/harnesses/presets/`, validates it against
 * `ENGINE_PRESET_SCHEMA`, materializes defaults, and returns an
 * `id → EnginePreset` map. Tier-1 engines are defined entirely by those files;
 * tier-2 engines (`claude-code`, `codex`) keep a code adapter and are not
 * represented here.
 *
 * Failure policy, copied verbatim from the two places this repo already solved
 * it (`server/workflows/presets.ts` §3.2 and `server/plugins/loader.ts`): one
 * bad file never takes the load down. Unreadable directory, unparseable JSON,
 * schema violation, shell-unsafe command — each is a `logger.warn` plus a skip,
 * and every other preset still loads. Nothing in this module throws.
 *
 * Filename is authoritative for the id. A file whose `id` disagrees with its
 * stem loads under the stem, with a warn — same rule the plugin qualifier
 * applies, minus the hard rejection, because an engine preset has no namespace
 * to collide across.
 */

import fs from 'fs';
import path from 'path';
import { childLogger } from '../logger.js';
import { assetRoot } from '../assets.js';
import { ENGINE_PRESET_ID_RE, checkEnginePresetShape, type EnginePreset } from './preset-schema.js';

const logger = childLogger('harnesses/preset-loader');

/**
 * Where the shipped preset files live.
 *
 * `__dirname` is unusable here: inside a `bun build --compile` binary it points
 * at the read-only `/$bunfs`, which can't be listed. `assetRoot()`
 * (`server/assets.ts`) is the repo's answer to exactly that — it returns the
 * package root when running from source and the unpacked
 * `~/.octomux/runtime/<version>/` tree when compiled — so the same join works
 * in both modes.
 *
 * Caveat for whoever wires the compiled build: `scripts/bundle-assets.mjs`
 * currently embeds only the top-level `plugin`, `kinds`, `templates`,
 * `workflows`, and `dist` trees, so `server/harnesses/presets` is not in the
 * binary yet. Until that list grows an entry, a compiled binary finds no
 * directory here — which, by the policy above, is an empty map and a debug
 * line, not a crash.
 *
 * `OCTOMUX_ENGINE_PRESETS_DIR` overrides for tests, mirroring
 * `OCTOMUX_KINDS_DIR` in `server/octomux-paths.ts`.
 */
export function enginePresetsDir(): string {
  return (
    process.env.OCTOMUX_ENGINE_PRESETS_DIR ||
    path.join(assetRoot(), 'server', 'harnesses', 'presets')
  );
}

let presets = new Map<string, EnginePreset>();

/** Read + parse every `*.json` in `dir`. Missing dir → `[]`; bad JSON → skip. */
function readPresetFiles(dir: string): Array<{ file: string; data: unknown }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    logger.debug({ dir, err }, 'engine presets: directory unreadable — no presets loaded');
    return [];
  }

  const out: Array<{ file: string; data: unknown }> = [];
  for (const file of names.sort()) {
    const full = path.join(dir, file);
    try {
      out.push({ file, data: JSON.parse(fs.readFileSync(full, 'utf-8')) });
    } catch (err) {
      logger.warn({ file: full, err }, 'engine preset: unparseable JSON — skipped');
    }
  }
  return out;
}

/**
 * Validate one already-parsed preset file. Returns `null` (with a
 * `logger.warn`) on any rejection — never throws.
 */
function validateEnginePreset(file: string, data: unknown): EnginePreset | null {
  const id = file.replace(/\.json$/, '');
  if (!ENGINE_PRESET_ID_RE.test(id)) {
    logger.warn(
      { file, pattern: ENGINE_PRESET_ID_RE.source },
      'engine preset: filename is not a valid engine id — skipped',
    );
    return null;
  }

  let result: ReturnType<typeof checkEnginePresetShape>;
  try {
    result = checkEnginePresetShape(data, id);
  } catch (err) {
    // checkEnginePresetShape is pure and shouldn't throw; belt-and-braces so a
    // future ajv compile error still can't take the whole load down.
    logger.warn({ file, err }, 'engine preset: validation threw — skipped');
    return null;
  }

  if (!result.ok) {
    logger.warn({ file, error: result.error }, 'engine preset: validation failed — skipped');
    return null;
  }
  for (const warning of result.warnings) {
    logger.warn({ file, id, warning }, 'engine preset: loaded with warning');
  }
  return result.preset;
}

/**
 * Load every preset in `dir` (default: `enginePresetsDir()`) into the in-memory
 * map and return it. Idempotent — call again to pick up on-disk edits.
 */
export function loadEnginePresets(dir: string = enginePresetsDir()): Map<string, EnginePreset> {
  const map = new Map<string, EnginePreset>();
  for (const { file, data } of readPresetFiles(dir)) {
    const preset = validateEnginePreset(file, data);
    if (preset) map.set(preset.id, preset);
  }
  logger.debug({ dir, count: map.size }, 'engine presets loaded');
  presets = map;
  return map;
}

export function getEnginePreset(id: string): EnginePreset | undefined {
  return presets.get(id);
}

export function listEnginePresets(): EnginePreset[] {
  return Array.from(presets.values());
}
