import { describe, it, expect } from '../bun-test.js';
import { validateAgentName, validateFlagString } from './types.js';
import type { CoreHarness, Harness } from './types.js';
import claudeCodeDefault, { claudeCodeHarness } from './claude-code.js';
import cursorDefault, { cursorHarness } from './cursor.js';

// Type-level: fails `bun run typecheck` if either harness stops satisfying
// the widened `Harness` interface (new members are all optional, so nothing
// here should have needed a code change).
const _harnessesSatisfyInterface: Harness[] = [claudeCodeHarness, cursorHarness];
void _harnessesSatisfyInterface;

// Type-level: both core harnesses must satisfy the STRICTER `CoreHarness`,
// where every engine-layer member (argv builders, capabilities,
// instructionFile, detectReady) is mandatory. They are optional on `Harness`
// itself only so partial stubs elsewhere keep compiling.
const _coreHarnesses: CoreHarness[] = [claudeCodeHarness, cursorHarness];
void _coreHarnesses;

describe('validateAgentName', () => {
  it.each([
    ['orchestrator', 'orchestrator'],
    ['plan-week', 'plan-week'],
    ['Agent_42', 'Agent_42'],
  ])('accepts %s', (input, expected) => {
    expect(validateAgentName(input)).toBe(expected);
  });

  it.each(['', 'has space', 'foo;rm -rf /', '../../../etc', 'a'.repeat(65), '$(whoami)'])(
    'rejects %s',
    (input) => {
      expect(() => validateAgentName(input)).toThrow(/Invalid agent name/);
    },
  );
});

describe('validateFlagString', () => {
  it.each(['', '--verbose', '--model claude-opus-4-7', "--prompt 'hello world'"])(
    'accepts %s',
    (input) => {
      expect(validateFlagString(input, 'flags')).toBe(input.trim());
    },
  );

  it.each([
    '`whoami`',
    '$(whoami)',
    '--verbose; rm -rf /',
    '| cat',
    '&& evil',
    '> /etc/passwd',
    'foo\nbar',
    "--unbalanced 'quote",
  ])('rejects %s', (input) => {
    expect(() => validateFlagString(input, 'flags')).toThrow(/Invalid flags/);
  });
});

describe('Harness interface surface', () => {
  it.each([
    ['claude-code', claudeCodeHarness, claudeCodeDefault],
    ['cursor', cursorHarness, cursorDefault],
  ])('%s: default export is the same object as the named export', (_id, named, def) => {
    expect(def).toBe(named);
  });

  it.each([
    ['claude-code', claudeCodeHarness],
    ['cursor', cursorHarness],
  ])('%s: syncAgents is gone', (_id, harness) => {
    expect('syncAgents' in harness).toBe(false);
  });

  // The four members whose own JSDoc says they were never wired. They are
  // @deprecated rather than deleted (removing them would break every external
  // `Harness` implementation), and no core harness implements them — so no
  // call site can start depending on them by accident.
  it.each([
    ['claude-code', claudeCodeHarness],
    ['cursor', cursorHarness],
  ])('%s: implements none of the deprecated members', (_id, harness) => {
    for (const member of ['buildPromptDelivery', 'attachMcp', 'sendMessage', 'detectActivity']) {
      expect(member in harness).toBe(false);
    }
  });

  it.each([
    ['claude-code', claudeCodeHarness],
    ['cursor', cursorHarness],
  ])('%s: argv builders and the string builders agree on arity', (_id, harness) => {
    expect(typeof harness.buildLaunchArgv).toBe('function');
    expect(typeof harness.buildResumeArgv).toBe('function');
    expect(typeof harness.buildContinueArgv).toBe('function');
    // Continue support is the same answer on both paths.
    const opts = { sessionId: 's1' };
    expect(harness.buildContinueArgv?.(opts) === null).toBe(
      harness.buildContinueCommand(opts) === null,
    );
  });
});
