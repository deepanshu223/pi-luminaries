import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename, open, symlink, link } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  FileLeaseConflictError,
  acquirePrivateFileLease,
  atomicReplacePrivateFile,
  canonicalPrivateFilePath,
} from '../../src/atomic-file.ts';

const fixture = resolve('test/fixtures/atomic-lease-child.mjs');
const writeFixture = resolve('test/fixtures/atomic-write-child.mjs');
const testRoot = await mkdtemp(join(tmpdir(), 'luminaries-atomic-'));
after(() => rm(testRoot, { recursive: true, force: true }));

async function freshState() {
  const root = await mkdtemp(join(testRoot, 'case-'));
  return { root, statePath: join(root, 'private', 'state.json') };
}
function spawnLease(t, statePath) {
  const child = spawn(process.execPath, [fixture, statePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child);
  });
  return child;
}
async function firstJsonLine(child, timeoutMs = 5_000) {
  return new Promise((resolveLine, rejectLine) => {
    let text = '';
    const timer = setTimeout(() => rejectLine(new Error(`child output timeout: ${text}`)), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectLine(error);
    });
    child.stdout.on('data', (chunk) => {
      text += String(chunk);
      const end = text.indexOf('\n');
      if (end >= 0) {
        clearTimeout(timer);
        resolveLine(JSON.parse(text.slice(0, end)));
      }
    });
  });
}
async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('child exit timeout')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}
async function writeOwner(lockPath, overrides = {}) {
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, 'owner.json'),
    `${JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquiredAtMs: Date.now(),
      ...overrides,
    })}\n`,
  );
}
test('retries transient replacement errors without unlinking the canonical file', async () => {
  const { statePath } = await freshState();
  const initial = await atomicReplacePrivateFile(statePath, 'old');
  if (process.platform === 'win32') assert.equal(initial.postCommitWarning, undefined);
  let calls = 0;
  const result = await atomicReplacePrivateFile(statePath, 'new', {
    renameDelaysMs: [0, 0],
    hooks: {
      beforeRename: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      },
      wait: async () => undefined,
    },
  });
  assert.equal(calls, 3);
  assert.equal(await readFile(result.path, 'utf8'), 'new');
});

test('distinguishes failures before and warnings after the rename commit boundary', async () => {
  const { statePath } = await freshState();
  await atomicReplacePrivateFile(statePath, 'old');
  await assert.rejects(
    atomicReplacePrivateFile(statePath, 'not-committed', {
      hooks: {
        observe: (phase) => {
          if (phase === 'temp-synced') throw new Error('pre-rename stop');
        },
      },
    }),
    /pre-rename stop/,
  );
  assert.equal(await readFile(statePath, 'utf8'), 'old');
  const observed = await atomicReplacePrivateFile(statePath, 'committed', {
    hooks: {
      observe: (phase) => {
        if (phase === 'renamed') throw new Error('post-rename observer');
      },
    },
  });
  assert.match(observed.postCommitWarning, /observer/);
  assert.equal(await readFile(statePath, 'utf8'), 'committed');
  const directoryWarning = await atomicReplacePrivateFile(statePath, 'also-committed', {
    hooks: {
      syncDirectory: async () => {
        throw Object.assign(new Error('x'.repeat(500)), { code: 'EPERM' });
      },
    },
  });
  assert.match(directoryWarning.postCommitWarning, /directory sync/);
  assert.equal(await readFile(statePath, 'utf8'), 'also-committed');
});

test('real process death before and after rename preserves the exact commit boundary', async (t) => {
  for (const [phase, expected] of [
    ['temp-synced', 'old'],
    ['renamed', 'new'],
  ]) {
    const { statePath } = await freshState();
    await atomicReplacePrivateFile(statePath, 'old');
    const child = spawn(process.execPath, [writeFixture, statePath, phase, 'new'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await waitForExit(child);
    });
    const paused = await firstJsonLine(child);
    assert.deepEqual(paused, { state: 'paused', phase });
    await assert.rejects(acquirePrivateFileLease(statePath), FileLeaseConflictError);
    child.kill('SIGKILL');
    await waitForExit(child);
    assert.equal(await readFile(statePath, 'utf8'), expected);
    if (phase === 'temp-synced') {
      assert.ok(
        (await readdir(dirname(statePath))).some((name) => name.startsWith('.state.json.') && name.endsWith('.tmp')),
      );
    }
    const lease = await acquirePrivateFileLease(statePath);
    t.after(() => lease.release());
    const remaining = await readdir(dirname(lease.statePath));
    assert.ok(!remaining.some((name) => name.startsWith('state.json.lock.stale-')));
    assert.ok(!remaining.some((name) => name.startsWith('.state.json.') && name.endsWith('.tmp')));
    await lease.release();
  }
});

test('real replacement preserves complete files across reader contention', async () => {
  const { statePath } = await freshState();
  const values = ['A'.repeat(16_384), 'B'.repeat(16_384)];
  await atomicReplacePrivateFile(statePath, values[0]);
  const heldReader = await open(statePath, 'r');
  try {
    if (process.platform === 'win32') {
      await assert.rejects(
        atomicReplacePrivateFile(statePath, values[1], { renameDelaysMs: [0, 10, 25] }),
        /EPERM|EACCES|EBUSY/,
      );
      assert.equal(await readFile(statePath, 'utf8'), values[0]);
    } else {
      await atomicReplacePrivateFile(statePath, values[1]);
      assert.equal(await readFile(statePath, 'utf8'), values[1]);
    }
  } finally {
    await heldReader.close();
  }
  await atomicReplacePrivateFile(statePath, values[1]);
  assert.equal(await readFile(statePath, 'utf8'), values[1]);
});

test('same-process aliases and a real second process cannot share the writer lease', async (t) => {
  const { root, statePath } = await freshState();
  const lease = await acquirePrivateFileLease(statePath);
  try {
    await assert.rejects(acquirePrivateFileLease(statePath), FileLeaseConflictError);
    if (process.platform === 'win32')
      await assert.rejects(acquirePrivateFileLease(statePath.toUpperCase()), FileLeaseConflictError);
    const child = spawnLease(t, statePath);
    const refusal = await firstJsonLine(child);
    const exited = await waitForExit(child);
    assert.equal(refusal.state, 'refused');
    assert.equal(exited.code, 3);

    const realParent = dirname(lease.statePath);
    const aliasParent = join(root, 'alias');
    try {
      await symlink(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.diagnostic(`alias test unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(acquirePrivateFileLease(join(aliasParent, 'state.json')), FileLeaseConflictError);
  } finally {
    await lease.release();
  }
});

test('malformed, remote, and live lease owners fail closed', async (t) => {
  for (const owner of [null, { hostname: 'remote-host' }, { hostname: hostname(), pid: process.pid }]) {
    const { statePath } = await freshState();
    const canonical = await canonicalPrivateFilePath(statePath);
    if (owner === null) {
      await mkdir(`${canonical.path}.lock`, { recursive: true });
      await writeFile(join(`${canonical.path}.lock`, 'owner.json'), 'not-json');
    } else await writeOwner(`${canonical.path}.lock`, owner);
    await assert.rejects(acquirePrivateFileLease(statePath), FileLeaseConflictError);
  }
  if (process.platform === 'win32') {
    for (const pid of [process.pid, 4]) {
      const { statePath } = await freshState();
      const canonical = await canonicalPrivateFilePath(statePath);
      await writeOwner(`${canonical.path}.lock`, {
        pid,
        acquiredAtMs: 0,
        processStartIdentity: 'runtime:0',
      });
      const reclaimed = await acquirePrivateFileLease(statePath);
      try {
        assert.ok(reclaimed.owner.processStartIdentity.startsWith('win32:'));
        const savedIdentity = reclaimed.owner.processStartIdentity;
        await reclaimed.release();
        await writeOwner(`${canonical.path}.lock`, {
          processStartIdentity: `win32:${BigInt(savedIdentity.slice(6)) + 1n}`,
        });
        await assert.rejects(acquirePrivateFileLease(statePath), FileLeaseConflictError);
        t.diagnostic(
          `Recovered isolated stale lease with reused PID ${pid}; retained live-owner fence across timestamp precision differences.`,
        );
      } finally {
        await reclaimed.release();
      }
    }
  }
});

test('release quarantines and rechecks the exact owner before deletion', async (t) => {
  const { statePath } = await freshState();
  let lease;
  const successorToken = randomUUID();
  lease = await acquirePrivateFileLease(statePath, {
    hooks: {
      beforeReleaseRename: async () => {
        await rename(lease.lockPath, `${lease.lockPath}.original`);
        await writeOwner(lease.lockPath, { token: successorToken });
      },
    },
  });
  t.after(() => lease.release());
  assert.equal(await lease.release(), false);
  const successor = JSON.parse(await readFile(join(lease.lockPath, 'owner.json'), 'utf8'));
  assert.equal(successor.token, successorToken);
  await rm(lease.lockPath, { recursive: true, force: true });
  await rm(`${lease.lockPath}.original`, { recursive: true, force: true });
});

test('canonicalization rejects target symlinks and hard links', async (t) => {
  const { root } = await freshState();
  const actual = join(root, 'actual.json');
  await writeFile(actual, '{}');
  const hard = join(root, 'hard.json');
  await link(actual, hard);
  await assert.rejects(canonicalPrivateFilePath(hard), /single-link/);
  const symbolic = join(root, 'symbolic.json');
  try {
    await symlink(actual, symbolic, 'file');
  } catch (error) {
    t.diagnostic(`file symlink test unavailable: ${error.message}`);
    return;
  }
  await assert.rejects(canonicalPrivateFilePath(symbolic), /single-link/);
});

test('failed lease acquisition preserves unverified artifacts and releases its own lock', async (t) => {
  const oversized = await freshState();
  await assert.rejects(atomicReplacePrivateFile(oversized.statePath, '1234', { maxBytes: 3 }), /exceeds/);
  const temps = await freshState();
  const canonicalTemps = await canonicalPrivateFilePath(temps.statePath);
  for (let index = 0; index < 17; index++)
    await writeFile(join(dirname(canonicalTemps.path), `.state.json.${process.pid}.${randomUUID()}.tmp`), 'x');
  await assert.rejects(acquirePrivateFileLease(temps.statePath), /artifact capacity/);
  await assert.rejects(readFile(`${canonicalTemps.path}.lock/owner.json`, 'utf8'), /ENOENT/);

  const candidate = await freshState();
  const canonicalCandidate = await canonicalPrivateFilePath(candidate.statePath);
  const abandonedCandidate = `${canonicalCandidate.path}.lock.candidate-${randomUUID()}`;
  await mkdir(abandonedCandidate);
  const candidateLease = await acquirePrivateFileLease(candidate.statePath);
  t.after(() => candidateLease.release());
  assert.equal(
    await readFile(join(abandonedCandidate, 'owner.json')).then(
      () => true,
      () => false,
    ),
    false,
  );
  await candidateLease.release();

  const malformedCandidate = await freshState();
  const canonicalMalformed = await canonicalPrivateFilePath(malformedCandidate.statePath);
  const oversizedCandidate = `${canonicalMalformed.path}.lock.candidate-${randomUUID()}`;
  await mkdir(oversizedCandidate);
  await writeFile(join(oversizedCandidate, 'junk.bin'), Buffer.alloc(8 * 1024 * 1024));
  await assert.rejects(acquirePrivateFileLease(malformedCandidate.statePath), /Malformed.*candidate/);
  assert.equal((await readFile(join(oversizedCandidate, 'junk.bin'))).byteLength, 8 * 1024 * 1024);

  const oversizedOwner = await freshState();
  const canonicalOwner = await canonicalPrivateFilePath(oversizedOwner.statePath);
  const ownerCandidate = `${canonicalOwner.path}.lock.candidate-${randomUUID()}`;
  await mkdir(ownerCandidate);
  await writeFile(join(ownerCandidate, 'owner.json'), 'x'.repeat(4097));
  await assert.rejects(acquirePrivateFileLease(oversizedOwner.statePath), /owner exceeds/);
});
