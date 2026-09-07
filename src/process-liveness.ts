export function processAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined;
  }
}
