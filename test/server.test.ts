import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import server from '../src/server.js';
import tui from '../src/tui.js';

describe('OpenCode package entrypoints', () => {
  it('exports a directly loadable server plugin', () => {
    expect(server.id).toBe('fast-jev-compaction-opencode');
    expect(typeof server.server).toBe('function');
  });

  it('exports a TUI companion for the Plugins dialog', () => {
    expect(tui.id).toBe('fast-jev-compaction-opencode');
    expect(typeof tui.tui).toBe('function');
  });

  it('ships source entrypoints that do not require install scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      files?: string[];
      exports?: Record<string, { import?: string }>;
      scripts?: Record<string, string>;
      workspaces?: unknown;
    };

    expect(pkg.files).toContain('src');
    expect(pkg.exports?.['./server']?.import).toBe('./src/server.ts');
    expect(pkg.exports?.['./tui']?.import).toBe('./src/tui.ts');

    const gitPreparationTriggers = [
      'build',
      'prepare',
      'preinstall',
      'install',
      'postinstall',
      'prepack',
    ];
    for (const name of gitPreparationTriggers) {
      expect(pkg.scripts?.[name]).toBeUndefined();
    }
    expect(pkg.workspaces).toBeUndefined();
  });
});
