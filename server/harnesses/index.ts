// Side-effect imports register the two tier-2 (code adapter) harnesses.
// ESM evaluates every static import before this module's body runs, so
// `claude-code` and `cursor` are already in the registry by the time the
// preset loop below executes — which is the ordering the collision guard
// depends on.
import './claude-code.js';
import './cursor.js';
import { freezeCoreHarnesses, registerHarness } from './registry.js';
import { loadEnginePresets } from './preset-loader.js';
import { createHarnessFromPreset } from './preset-harness.js';

// Tier-1 engines (spec/engine-layer.md §2.2): one `Harness` per validated
// preset file. Registered AFTER the core harnesses and BEFORE the freeze:
//
//   - after core, so a preset that claims `claude-code` or `cursor` loses to
//     the real adapter (`registerHarness` warns and keeps the first
//     registration) instead of shadowing it;
//   - before the freeze, because `freezeCoreHarnesses()` is the boundary that
//     separates first-party registration from plugin registration, and a
//     shipped preset is first-party.
for (const preset of loadEnginePresets().values()) {
  registerHarness(createHarnessFromPreset(preset));
}

// Lock the core ids against redefinition now that every first-party harness
// has registered, and before any plugin harness gets a chance to load.
freezeCoreHarnesses();

export * from './types.js';
export {
  applyModel,
  buildClaudeContinueCommand,
  buildClaudeLaunchCommand,
  buildClaudeResumeCommand,
  formatHarnessFlags,
  formatJsonConfig,
  validateSettingsObject,
  writeJsonConfig,
  // Engine layer (spec/engine-layer.md §2.1): argv is the source of truth, the
  // *Command builders above are shell-quoting wrappers over these.
  applyModelArgv,
  argvToCommand,
  buildClaudeContinueArgv,
  buildClaudeLaunchArgv,
  buildClaudeResumeArgv,
  composeArgv,
  composeCommand,
  shellQuoteIfNeeded,
  shellSplitFlags,
} from './shared.js';
// Normalized cross-engine event contract (spec/engine-layer.md §2.3).
export * from './events.js';
// Declarative tier-1 engine presets (spec/engine-layer.md §2.2).
export type { EnginePreset } from './preset-schema.js';
export {
  enginePresetsDir,
  getEnginePreset,
  listEnginePresets,
  loadEnginePresets,
} from './preset-loader.js';
export { createHarnessFromPreset } from './preset-harness.js';
export {
  registerHarness,
  getHarness,
  listHarnesses,
  DEFAULT_HARNESS_ID,
  CORE_HARNESS_IDS,
  freezeCoreHarnesses,
  resetHarnesses,
} from './registry.js';
export { claudeCodeHarness } from './claude-code.js';
export { cursorHarness } from './cursor.js';
