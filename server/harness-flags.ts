import { getSettings } from './settings.js';
import { appendOctomuxPluginFlags, type OctomuxPluginFlagOpts } from './octomux-plugin.js';
import type { Harness } from './harnesses/types.js';

/** Resolve harness flags with the bundled octomux plugin (and optional skill overrides). */
export async function resolveHarnessFlags(
  harness: Harness,
  pluginOpts?: OctomuxPluginFlagOpts,
): Promise<string> {
  const base = harness.resolveFlags(await getSettings());
  return appendOctomuxPluginFlags(base, pluginOpts);
}

/**
 * Resolve the environment a launch of `harness` needs.
 *
 * Two layers, in order: the engine's static `env` (what a tier-1 preset
 * declares), then whatever `resolveEnv` derives from user settings (what an
 * operator configures). Settings win, so pointing an engine at a gateway
 * overrides its built-in default rather than fighting it.
 */
export async function resolveHarnessEnv(harness: Harness): Promise<Record<string, string>> {
  const settings = await getSettings();
  return { ...harness.env, ...harness.resolveEnv?.(settings) };
}
