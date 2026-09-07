export type AtomicWriteData = string | Uint8Array;
export type AtomicWritePhase = 'temp-synced' | 'renamed' | 'directory-synced';
export interface AtomicWriteHooks {
    beforeRename?: (attempt: number) => void | Promise<void>;
    syncDirectory?: (directory: string) => Promise<void>;
    observe?: (phase: AtomicWritePhase) => void | Promise<void>;
    wait?: (milliseconds: number) => Promise<void>;
}
export interface AtomicWriteOptions {
    maxBytes?: number;
    renameDelaysMs?: readonly number[];
    hooks?: AtomicWriteHooks;
}
export interface AtomicWriteResult {
    path: string;
    bytes: number;
    postCommitWarning?: string;
}
export interface FileLeaseOwner {
    version: 1;
    token: string;
    pid: number;
    hostname: string;
    processStartIdentity?: string;
    acquiredAtMs: number;
}
export interface FileLeaseHooks {
    beforeReleaseRename?: () => void | Promise<void>;
}
export interface FileLeaseOptions {
    hooks?: FileLeaseHooks;
}
export interface PrivateFileLease {
    readonly statePath: string;
    readonly lockPath: string;
    readonly owner: FileLeaseOwner;
    replace(data: AtomicWriteData, options?: AtomicWriteOptions): Promise<AtomicWriteResult>;
    replaceSibling(suffix: string, data: AtomicWriteData, options?: AtomicWriteOptions): Promise<AtomicWriteResult>;
    release(): Promise<boolean>;
}
export declare class FileLeaseConflictError extends Error {
    readonly owner?: FileLeaseOwner;
    readonly ownerIsLiveOrIndeterminate: boolean;
    constructor(message: string, owner?: FileLeaseOwner, ownerIsLiveOrIndeterminate?: boolean);
}
/** Resolve one private file namespace. The final target must be absent or a single-link regular file, never a symlink. */
export declare function canonicalPrivateFilePath(input: string): Promise<{
    path: string;
    key: string;
}>;
/** Commit complete bytes by canonical same-directory private replacement. */
export declare function atomicReplacePrivateFile(filePath: string, data: AtomicWriteData, options?: AtomicWriteOptions): Promise<AtomicWriteResult>;
/** Acquire one lifetime writer lease for a canonical private state namespace. */
export declare function acquirePrivateFileLease(input: string, options?: FileLeaseOptions): Promise<PrivateFileLease>;
