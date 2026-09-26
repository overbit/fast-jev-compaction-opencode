import { describe, expect, it } from 'vitest';

import server from '../src/server.js';

describe('OpenCode package entrypoint', () => {
  it('exports a directly loadable server plugin', () => {
    expect(server.id).toBe('fast-jev-compaction-opencode');
    expect(typeof server.server).toBe('function');
  });
});
