import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import server from '../src/server.js';
import tui from '../src/tui.js';

describe('OpenCode V2 package entrypoints', () => {
  it('exports a V2 server plugin definition', () => {
    expect(server.id).toBe('fast-jev-compaction-opencode');
    expect(typeof server.setup).toBe('function');
  });

  it('exports a V2 TUI plugin definition', () => {
    expect(tui.id).toBe('fast-jev-compaction-opencode');
    expect(typeof tui.setup).toBe('function');
  });

  it('ships source entrypoints without git preparation hooks', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      files?: string[];
      exports?: Record<string, { import?: string }>;
      scripts?: Record<string, string>;
      workspaces?: unknown;
      dependencies?: Record<string, string>;
      engines?: Record<string, string>;
    };

    expect(pkg.files).toContain('src');
    expect(pkg.exports?.['.']?.import).toBe('./src/index.ts');
    expect(pkg.exports?.['./server']?.import).toBe('./src/server.ts');
    expect(pkg.exports?.['./tui']?.import).toBe('./src/tui.ts');
    expect(pkg.dependencies?.['@opencode/plugin']).toMatch(/^\^2\./);
    expect(pkg.engines?.opencode).toContain('>=2.0.0');

    for (const name of ['build', 'prepare', 'preinstall', 'install', 'postinstall', 'prepack']) {
      expect(pkg.scripts?.[name]).toBeUndefined();
    }
    expect(pkg.workspaces).toBeUndefined();
  });
});
