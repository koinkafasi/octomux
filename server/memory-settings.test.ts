import { describe, it, expect } from './bun-test.js';
import { parseMemorySettings, memoryMcpEntry, validateMemorySettings } from './memory-settings.js';

const valid = { provider: 'hindsight', url: 'http://localhost:8888', bank: 'octomux' };

describe('parseMemorySettings', () => {
  it('accepts a well-formed block', () => {
    expect(parseMemorySettings(valid)).toEqual({
      provider: 'hindsight',
      url: 'http://localhost:8888',
      bank: 'octomux',
    });
  });

  it('strips trailing slashes so the bank path never doubles up', () => {
    expect(parseMemorySettings({ ...valid, url: 'http://localhost:8888///' })?.url).toBe(
      'http://localhost:8888',
    );
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'hindsight'],
    ['a number', 7],
  ])('returns undefined when the block is %s', (_label, blob) => {
    expect(parseMemorySettings(blob)).toBeUndefined();
  });

  it.each([
    ['an unknown provider', { ...valid, provider: 'mem0' }],
    ['a missing url', { provider: 'hindsight', bank: 'octomux' }],
    ['a missing bank', { provider: 'hindsight', url: 'http://localhost:8888' }],
    ['a non-string url', { ...valid, url: 8888 }],
    ['a relative url', { ...valid, url: '/mcp' }],
    ['a non-http scheme', { ...valid, url: 'file:///etc/passwd' }],
    ['a javascript url', { ...valid, url: 'javascript:alert(1)' }],
    ['a bank with a slash', { ...valid, bank: 'a/b' }],
    ['a bank with a dot-dot', { ...valid, bank: '..' }],
    ['an empty bank', { ...valid, bank: '' }],
  ])('disables memory for %s rather than throwing', (_label, blob) => {
    // A bad block must never fail a task launch — it degrades to "no memory".
    expect(() => parseMemorySettings(blob)).not.toThrow();
    expect(parseMemorySettings(blob)).toBeUndefined();
  });
});

describe('memoryMcpEntry', () => {
  it('builds the per-bank endpoint Hindsight actually serves', () => {
    // Verified against hindsight-mcp-server 0.9.1: /mcp/<bank>/ answers
    // `initialize` and advertises tools.
    expect(memoryMcpEntry(parseMemorySettings(valid)!)).toEqual({
      type: 'http',
      url: 'http://localhost:8888/mcp/octomux/',
    });
  });
});

describe('validateMemorySettings — write path', () => {
  it('returns undefined for an absent block', () => {
    expect(validateMemorySettings(undefined)).toBeUndefined();
    expect(validateMemorySettings(null)).toBeUndefined();
  });

  it('accepts what the read path accepts', () => {
    expect(validateMemorySettings(valid)?.bank).toBe('octomux');
  });

  it.each([
    ['an unknown provider', { ...valid, provider: 'mem0' }],
    ['a relative url', { ...valid, url: '/mcp' }],
    ['a bank with a slash', { ...valid, bank: 'a/b' }],
  ])('throws for %s instead of silently discarding it', (_label, blob) => {
    // The lenient read path degrades; an explicit PATCH must report the reason.
    expect(() => validateMemorySettings(blob)).toThrow('Invalid memory settings');
  });
});
