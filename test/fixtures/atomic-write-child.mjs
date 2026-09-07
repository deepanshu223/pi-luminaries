import { acquirePrivateFileLease } from '../../src/atomic-file.ts';

const [, , statePath, phase, value] = process.argv;
const lease = await acquirePrivateFileLease(statePath);
try {
  await lease.replace(value, {
    hooks: {
      observe: async (observed) => {
        if (observed !== phase) return;
        await new Promise((resolve) =>
          process.stdout.write(`${JSON.stringify({ state: 'paused', phase: observed })}\n`, resolve),
        );
        setInterval(() => undefined, 1_000);
        await new Promise(() => undefined);
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ state: 'finished' })}\n`);
} finally {
  await lease.release();
}
