import { acquirePrivateFileLease } from '../../src/atomic-file.ts';

const [, , mode, statePath] = process.argv;
try {
  const lease = await acquirePrivateFileLease(statePath);
  process.stdout.write(`${JSON.stringify({ state: 'acquired', pid: process.pid, token: lease.owner.token })}\n`);
  if (mode === 'hold') setInterval(() => undefined, 1_000);
  else {
    await lease.release();
    process.exit(0);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ state: 'refused', name: error?.name, message: error?.message })}\n`);
  process.exit(3);
}
