/**
 * server/harnesses/normalize/plain-text.ts
 *
 * The fallback normalizer: for engines with no structured output at all.
 *
 * Several of the twelve engines in spec/engine-layer.md §3 print nothing but
 * human-facing prose on stdout — no NDJSON, no JSON-RPC, no ACP. Rather than let
 * those engines bypass the event contract, everything they print becomes a
 * `message` event, one per line, with terminal escape sequences removed.
 *
 * It is intentionally dumb. It never invents `tool_call`, `usage`, or `done`
 * events, because a plain-text engine gives no honest basis for any of them — a
 * lifecycle signal for these engines comes from the process exit, not from parsing
 * its prose. `HarnessCapabilities.contextUsage` (§2.4) is what tells the UI not to
 * expect a cost card here.
 */

import { LineBuffer, textBlock, type AgentEvent, type Normalizer } from '../events.js';

/**
 * String-terminated sequences: OSC (window title, hyperlinks) plus its DCS / SOS /
 * PM / APC siblings. Their payload is arbitrary text — a window title contains
 * spaces, an OSC 8 hyperlink contains a URL — so it is matched lazily up to the
 * first terminator (BEL, `ESC \`, or the 8-bit ST) rather than by a character class.
 * Stripped FIRST: matched after CSI, an `OSC 0 ;` introducer is eaten as a malformed
 * CSI and the title leaks out as prose.
 */
const OSC_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\u001B[\]P^_X]|[\u0090\u0098\u009D\u009E\u009F])[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;

/**
 * CSI — colour, cursor movement, erase. ECMA-48 shape: parameter bytes `0x30-0x3F`,
 * then intermediate bytes `0x20-0x2F`, then exactly one final byte `0x40-0x7E`.
 */
// eslint-disable-next-line no-control-regex
const CSI_RE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;

/** Whatever escapes remain: `ESC 7`, `ESC =`, charset designators like `ESC ( B`. */
// eslint-disable-next-line no-control-regex
const ESC_RE = /\u001B[ -/]*[0-~]/g;

/** C0 controls other than tab and newline — backspace, bell, carriage return, etc. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Strip terminal escape sequences and stray control bytes from a line of output. */
export function stripAnsi(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(CONTROL_RE, '');
}

export interface PlainTextNormalizerOptions {
  /** Which side of the conversation this stream belongs to. Defaults to the agent. */
  role?: 'assistant' | 'user';
  /**
   * Emit lines that are empty once escapes are stripped. Off by default: a TUI
   * repainting itself produces a great many of them and they carry nothing.
   */
  keepBlankLines?: boolean;
}

export class PlainTextNormalizer implements Normalizer {
  private readonly lines = new LineBuffer();
  private readonly role: 'assistant' | 'user';
  private readonly keepBlankLines: boolean;

  constructor(options: PlainTextNormalizerOptions = {}) {
    this.role = options.role ?? 'assistant';
    this.keepBlankLines = options.keepBlankLines ?? false;
  }

  push(chunk: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const line of this.lines.push(chunk)) this.emit(line, out);
    return out;
  }

  flush(): AgentEvent[] {
    const out: AgentEvent[] = [];
    const rest = this.lines.flush();
    if (rest !== null) this.emit(rest, out);
    return out;
  }

  private emit(rawLine: string, out: AgentEvent[]): void {
    const text = stripAnsi(rawLine);
    if (!this.keepBlankLines && text.trim() === '') return;
    out.push({ t: 'message', content: textBlock(text), role: this.role });
  }
}

/** One normalizer per run. */
export function createPlainTextNormalizer(options?: PlainTextNormalizerOptions): Normalizer {
  return new PlainTextNormalizer(options);
}

/** Whole-stream convenience wrapper, mirroring the claude-code normalizer. */
export function normalizePlainText(
  text: string,
  options?: PlainTextNormalizerOptions,
): AgentEvent[] {
  const n = new PlainTextNormalizer(options);
  return [...n.push(text), ...n.flush()];
}
