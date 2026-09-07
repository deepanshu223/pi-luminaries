import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename, open, symlink, link } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FileLeaseConflictError, acquirePrivateFileLease, canonicalPrivateFilePath } from '../../src/atomic-file.ts';

const fixture = resolve('test/fixtures/atomic-lease-child.mjs');
const writeFixture = resolve('test/fixtures/atomic-write-child.mjs');
const testRoot = await mkdtemp(join(tmpdir(), 'luminaries-atomic-'));
after(() => rm(testRoot, { recursive: true, force: true }));

async function freshState() {
  const root = await mkdtemp(join(testRoot, 'case-'));
  return { root, statePath: join(root, 'private', 'state.json') };
}
function spawnLease(t, mode, statePath) {
  const child = spawn(process.execPath, [fixture, mode, statePath], {
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
async function replaceOnce(statePath, data, options) {
  const lease = await acquirePrivateFileLease(statePath);
  try {
    return await lease.replace(data, options);
  } finally {
    await lease.release();
  }
}

test('atomically replaces private bytes and returns canonical provenance', async () => {
  const { statePath } = await freshState();
  const first = await replaceOnce(statePath, '{"revision":1}\n');
  const second = await replaceOnce(statePath, '{"revision":2}\n');
  assert.equal(await readFile(first.path, 'utf8'), '{"revision":2}\n');
  assert.equal(first.path, second.path);
  assert.equal(first.bytes, 15);
});

test('retries transient replacement errors without unlinking the canonical file', async () => {
  const { statePath } = await freshState();
  const initial = await replaceOnce(statePath, 'old');
  if (process.platform === 'win32') assert.equal(initial.postCommitWarning, undefined);
  let calls = 0;
  const result = await replaceOnce(statePath, 'new', {
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
  await replaceOnce(statePath, 'old');
  await assert.rejects(
    replaceOnce(statePath, 'not-committed', {
      hooks: {
        observe: (phase) => {
          if (phase === 'temp-synced') throw new Error('pre-rename stop');
        },
      },
    }),
    /pre-rename stop/,
  );
  assert.equal(await readFile(statePath, 'utf8'), 'old');
  const observed = await replaceOnce(statePath, 'committed', {
    hooks: {
      observe: (phase) => {
        if (phase === 'renamed') throw new Error('post-rename observer');
      },
    },
  });
  assert.match(observed.postCommitWarning, /observer/);
  assert.ok(observed.postCommitWarning.length <= 500);
  assert.equal(await readFile(statePath, 'utf8'), 'committed');
  const directoryWarning = await replaceOnce(statePath, 'also-committed', {
    hooks: {
      syncDirectory: async () => {
        throw Object.assign(new Error('x'.repeat(500)), { code: 'EPERM' });
      },
    },
  });
  assert.match(directoryWarning.postCommitWarning, /directory sync/);
  assert.ok(directoryWarning.postCommitWarning.length <= 500);
  assert.equal(await readFile(statePath, 'utf8'), 'also-committed');
});

test('real process death before and after rename preserves the exact commit boundary', async (t) => {
  for (const [phase, expected] of [
    ['temp-synced', 'old'],
    ['renamed', 'new'],
  ]) {
    const { statePath } = await freshState();
    await replaceOnce(statePath, 'old');
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
      const lease = await acquirePrivateFileLease(statePath);
      await lease.release();
      assert.equal(
        (await readdir(dirname(statePath))).some((name) => name.startsWith('.state.json.') && name.endsWith('.tmp')),
        false,
      );
    }
  }
});

test('real replacement never exposes a missing or partial canonical file', async () => {
  const { statePath } = await freshState();
  const values = ['A'.repeat(16_384), 'B'.repeat(16_384)];
  await replaceOnce(statePath, values[0]);
  const heldReader = await open(statePath, 'r');
  try {
    if (process.platform === 'win32') {
      await assert.rejects(replaceOnce(statePath, values[1], { renameDelaysMs: [0, 10, 25] }), /EPERM|EACCES|EBUSY/);
      assert.equal(await readFile(statePath, 'utf8'), values[0]);
    } else {
      await replaceOnce(statePath, values[1]);
      assert.equal(await readFile(statePath, 'utf8'), values[1]);
    }
  } finally {
    await heldReader.close();
  }
  await replaceOnce(statePath, values[1]);
  let running = true;
  const reads = [];
  const reader = (async () => {
    while (running) {
      const value = await readFile(statePath, 'utf8');
      reads.push(value[0]);
      assert.ok(value === values[0] || value === values[1]);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  })();
  try {
    const lease = await acquirePrivateFileLease(statePath);
    try {
      for (let index = 0; index < 30; index++) await lease.replace(values[index % 2]);
    } finally {
      await lease.release();
    }
  } finally {
    running = false;
    await reader;
  }
  assert.ok(reads.length > 0);
});

test('one lease owns canonical and bounded sibling replacements', async (t) => {
  const { statePath } = await freshState();
  const lease = await acquirePrivateFileLease(statePath);
  t.after(() => lease.release());
  await lease.replace('first');
  await lease.replace('second');
  assert.equal(await readFile(lease.statePath, 'utf8'), 'second');
  await lease.replaceSibling('corrupt-0', 'evidence');
  assert.equal(await readFile(`${lease.statePath}.corrupt-0`, 'utf8'), 'evidence');
  await assert.rejects(lease.replaceSibling('../escape', 'no'), /suffix/);
  await assert.rejects(lease.replaceSibling(`lock.candidate-${randomUUID()}`, 'poison'), /reserved/);
  await assert.rejects(lease.replaceSibling(`LOCK.STALE-${randomUUID()}`, 'poison'), /reserved/);
  assert.equal(await lease.release(), true);
  await assert.rejects(lease.replace('after-close'), /closing|released/);
  const reacquired = await acquirePrivateFileLease(statePath);
  await reacquired.release();
});

test('same-process aliases and a real second process cannot share the writer lease', async (t) => {
  const { root, statePath } = await freshState();
  const lease = await acquirePrivateFileLease(statePath);
  try {
    await assert.rejects(acquirePrivateFileLease(statePath), FileLeaseConflictError);
    if (process.platform === 'win32')
      await assert.rejects(acquirePrivateFileLease(statePath.toUpperCase()), FileLeaseConflictError);
    const child = spawnLease(t, 'try', statePath);
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

test('a killed real owner is reclaimed through an exact stale tombstone', async (t) => {
  const { statePath } = await freshState();
  const child = spawnLease(t, 'hold', statePath);
  const owner = await firstJsonLine(child);
  assert.equal(owner.state, 'acquired');
  child.kill('SIGKILL');
  await waitForExit(child);
  const lease = await acquirePrivateFileLease(statePath);
  try {
    const names = await readdir(dirname(lease.statePath));
    assert.equal(names.includes(`state.json.lock.stale-${owner.token}`), false);
  } finally {
    await lease.release();
  }
});

test('malformed, remote, and live lease owners fail closed', async () => {
  for (const owner of [null, { hostname: 'remote-host' }, { hostname: hostname(), pid: process.pid }]) {
    const { statePath } = await freshState();
    const canonical = await canonicalPrivateFilePath(statePath);
    if (owner === null) {
      await mkdir(`${canonical.path}.lock`, { recursive: true });
      await writeFile(join(`${canonical.path}.lock`, 'owner.json'), 'not-json');
    } else await writeOwner(`${canonical.path}.lock`, owner);
    await assert.rejects(acquirePrivateFileLease(statePath), FileLeaseConflictError);
  }
});

test('release is exact-token, idempotent, and never removes a successor owner', async (t) => {
  const { statePath } = await freshState();
  const lease = await acquirePrivateFileLease(statePath);
  t.after(() => lease.release());
  await writeOwner(lease.lockPath, { token: randomUUID() });
  assert.equal(await lease.release(), false);
  assert.equal(await lease.release(), false);
  assert.equal(await readFile(join(lease.lockPath, 'owner.json'), 'utf8').then(() => true), true);
  await rm(lease.lockPath, { recursive: true, force: true });
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

test('temporary and payload bounds fail while dead-owner recovery has no lifetime quota', async (t) => {
  const oversized = await freshState();
  await assert.rejects(replaceOnce(oversized.statePath, '1234', { maxBytes: 3 }), /exceeds/);
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

  const tombstones = await freshState();
  const canonicalTombstones = await canonicalPrivateFilePath(tombstones.statePath);
  for (let index = 0; index < 8; index++) {
    const token = randomUUID();
    await writeOwner(`${canonicalTombstones.path}.lock.stale-${token}`, {
      token,
      pid: 2147483647,
      hostname: 'remote-host',
    });
  }
  for (let index = 0; index < 12; index++) {
    await writeOwner(`${canonicalTombstones.path}.lock`, { pid: 2147483647 });
    const tombstoneLease = await acquirePrivateFileLease(tombstones.statePath);
    t.after(() => tombstoneLease.release());
    await tombstoneLease.release();
  }
  assert.equal(
    (await readdir(dirname(canonicalTombstones.path))).filter((name) => name.startsWith('state.json.lock.stale-'))
      .length,
    8,
  );
  const ambiguousToken = randomUUID();
  await writeOwner(`${canonicalTombstones.path}.lock.stale-${ambiguousToken}`, {
    token: ambiguousToken,
    pid: 2147483647,
    hostname: 'remote-host',
  });
  await assert.rejects(acquirePrivateFileLease(tombstones.statePath), /could not be proven dead/);
});
