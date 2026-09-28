import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, defaultLogPath, errorSummary, safeUrl } from '../src/log.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fast-jev-log-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('file logger', () => {
  it('writes timestamped lines and creates the parent directory', () => {
    const logFile = join(temporaryDirectory(), 'nested', 'plugin.log');
    const logger = createLogger(logFile);

    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logger.info('compaction outcome', { outcome: 'override', candidates: 2 });

    const contents = readFileSync(logFile, 'utf8');
    expect(contents).toMatch(
      /^\d{4}-\d\d-\d\dT.* \[INFO\] \[fast-jev-compaction-opencode\] compaction outcome \{"outcome":"override","candidates":2\}\n$/,
    );
  });

  it('disables an unwritable file sink without throwing or repeatedly warning', () => {
    const blocker = join(temporaryDirectory(), 'not-a-directory');
    writeFileSync(blocker, 'file');
    const logger = createLogger(join(blocker, 'plugin.log'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    expect(() => {
      logger.info('first');
      logger.info('second');
    }).not.toThrow();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('uses XDG_DATA_HOME and strips endpoint credentials and query values', () => {
    vi.stubEnv('XDG_DATA_HOME', '/tmp/opencode-data');

    expect(defaultLogPath()).toBe('/tmp/opencode-data/opencode/log/fast-jev-compaction.log');
    expect(safeUrl('http://user:secret@localhost:1234/v1?token=secret')).toBe(
      'http://localhost:1234/v1',
    );
  });

  it('summarizes request failures without logging response content', () => {
    const summary = errorSummary(new Error('local classifier request failed (500): prompt echoed by server'));

    expect(summary).toEqual({
      errorName: 'Error',
      reason: 'http-request-failed',
      status: '500',
    });
    expect(JSON.stringify(summary)).not.toContain('prompt echoed');
  });
});
