import { acquirePrivateFileLease } from '../../src/atomic-file.ts';

const [, , statePath] = process.argv;
try {
  const lease = await acquirePrivateFileLease(statePath);
  process.stdout.write(`${JSON.stringify({ state: 'acquired', pid: process.pid, token: lease.owner.token })}\n`);
  await lease.release();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ state: 'refused', name: error?.name, message: error?.message })}\n`);
  process.exit(3);
}
