import { childLogger } from './logger.js';

const logger = childLogger('memory-settings');

/**
 * Optional long-term memory provider exposed to workers as an MCP server.
 *
 * Off unless configured: without a `memory` block nothing is written into the
 * worker's MCP config and agents behave exactly as before. This is deliberately
 * not a harness setting — memory is a property of the workspace, not of the
 * engine running in it, so switching engines must not switch memory.
 */
export interface MemorySettings {
  /** Only Hindsight today; the field exists so a second provider is additive. */
  provider: 'hindsight';
  /** Server root, e.g. `http://localhost:8888`. The bank path is appended. */
  url: string;
  /** Hindsight bank id. Memories are scoped to it. */
  bank: string;
}

const BANK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Validate a settings blob into `MemorySettings`, or return undefined.
 *
 * Never throws: a malformed block disables memory with a warning rather than
 * failing every task launch. The url is checked the same way a gateway base is
 * — it reaches an agent's MCP config, so only absolute http(s) is accepted.
 */
export function parseMemorySettings(blob: unknown): MemorySettings | undefined {
  if (blob === undefined || blob === null) return undefined;
  if (typeof blob !== 'object') {
    logger.warn('settings.memory is not an object — memory disabled');
    return undefined;
  }
  const raw = blob as Record<string, unknown>;

  if (raw.provider !== 'hindsight') {
    logger.warn(
      { provider: raw.provider },
      'settings.memory.provider unsupported — memory disabled',
    );
    return undefined;
  }
  if (typeof raw.url !== 'string' || typeof raw.bank !== 'string') {
    logger.warn('settings.memory needs string url and bank — memory disabled');
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.url.trim());
  } catch {
    logger.warn({ url: raw.url }, 'settings.memory.url is not an absolute URL — memory disabled');
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logger.warn(
      { protocol: parsed.protocol },
      'settings.memory.url must be http(s) — memory disabled',
    );
    return undefined;
  }
  const bank = raw.bank.trim();
  if (!BANK_RE.test(bank)) {
    // The bank becomes a path segment; keeping it to this alphabet means no
    // escaping question ever arises.
    logger.warn({ bank }, 'settings.memory.bank has unsupported characters — memory disabled');
    return undefined;
  }

  return { provider: 'hindsight', url: raw.url.trim().replace(/\/+$/, ''), bank };
}

/** The MCP server entry a worker needs to reach this memory provider. */
export interface MemoryMcpEntry {
  type: 'http';
  url: string;
}

/**
 * Hindsight serves one MCP endpoint per bank at `/mcp/<bank>/`, verified
 * against 0.9.1: it answers `initialize` over SSE and advertises tools.
 */
export function memoryMcpEntry(memory: MemorySettings): MemoryMcpEntry {
  return { type: 'http', url: `${memory.url}/mcp/${memory.bank}/` };
}

/**
 * Write-path validator: throws instead of degrading.
 *
 * `parseMemorySettings` is lenient because a bad block on disk must not fail
 * every launch. An explicit PATCH is different — silently discarding what an
 * operator just set is worse than a 400, so this one reports the reason.
 */
export function validateMemorySettings(blob: unknown): MemorySettings | undefined {
  if (blob === undefined || blob === null) return undefined;
  const parsed = parseMemorySettings(blob);
  if (!parsed) {
    throw new Error(
      'Invalid memory settings: expected { provider: "hindsight", url: <http(s) URL>, bank: <[A-Za-z0-9_-], max 64> }',
    );
  }
  return parsed;
}
