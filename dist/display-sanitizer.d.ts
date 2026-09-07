import { isAsciiControlCharacter } from './identifiers.ts';
export declare const PRIVATE_STATE_LABEL: string;
export declare function isDisplaySecretKey(value: string): boolean;
export declare function normalizePathSeparators(value: string): string;
/** Normalize and order private roots once before sanitizing many values from one image. */
export declare function preparePrivateDisplayPaths(privatePaths: readonly string[]): readonly string[];
export declare function isPrivateDisplayReference(value: string, privatePaths: readonly string[]): boolean;
export declare function scrubPrivateDisplayReferences(value: string, privatePaths: readonly string[]): string;
/** Remove credential values while preserving the surrounding diagnostic structure. */
export declare function scrubDisplaySecrets(value: string): string;
/** Preserve ordinary Unicode, line breaks, and tabs while neutralizing terminal-shaping controls. */
export declare function scrubUnsafeTerminalControls(value: string): string;
export declare function sanitizeDisplayText(value: string, privatePaths: readonly string[]): string;
export declare function sanitizePreparedDisplayText(value: string, privatePaths: readonly string[]): string;
export declare function normalizeLineEndings(value: string): string;
export declare function collapseWhitespace(value: string): string;
export declare function splitWhitespace(value: string): string[];
export { isAsciiControlCharacter };
