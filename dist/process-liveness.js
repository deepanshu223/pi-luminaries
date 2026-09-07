export function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined;
    }
}
