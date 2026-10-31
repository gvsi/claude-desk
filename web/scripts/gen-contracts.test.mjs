// @vitest-environment node
// The contract type generator's command (gen-contracts.mjs): it refuses an unknown argument, and
// still does when started through a symlinked path rather than doing nothing. What it generates is
// tested in src/api/contracts.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./gen-contracts.mjs', import.meta.url));

/** Every temp folder made by a test, removed after it. */
const made = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the command at `script` with an unknown argument. */
function runMisspelled(script) {
  return spawnSync(process.execPath, [script, '--chek'], { encoding: 'utf8' });
}

describe('gen-contracts', () => {
  it('command_refuses_unknown_arguments', () => {
    const run = runMisspelled(SCRIPT);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown argument: --chek. Use --check to verify without writing.');
    expect(run.stdout).not.toContain('Wrote');
  });

  it('command_runs_through_a_symlinked_path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gen-contracts-link-'));
    made.push(dir);
    symlinkSync(path.dirname(SCRIPT), path.join(dir, 'scripts'), 'dir');
    const run = runMisspelled(path.join(dir, 'scripts', 'gen-contracts.mjs'));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown argument: --chek.');
  });
});
