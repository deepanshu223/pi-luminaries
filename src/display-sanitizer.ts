import { isAsciiControlCharacter } from './identifiers.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

export const PRIVATE_STATE_LABEL = `${LUMINARIES_IDENTITY.label} private state`;
const SECRET_KEYS = [
  'api-key',
  'api_key',
  'apikey',
  'authorization',
  'credential',
  'password',
  'secret',
  'token',
] as const;

export function isDisplaySecretKey(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  return (
    SECRET_KEYS.some((key) => normalized === key) ||
    normalized.endsWith('_key') ||
    normalized.endsWith('-key') ||
    trimmed.endsWith('Key') ||
    ['credential', 'password', 'secret', 'token'].some((suffix) => normalized.endsWith(suffix))
  );
}

export function normalizePathSeparators(value: string): string {
  let result = '';
  for (const character of value) result += character === '\\' ? '/' : character;
  return result;
}

function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end--;
  return value.slice(0, end);
}

/** Normalize and order private roots once before sanitizing many values from one image. */
export function preparePrivateDisplayPaths(privatePaths: readonly string[]): readonly string[] {
  return privatePaths
    .map(trimTrailingSeparators)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function pathIdentity(value: string): string {
  return trimTrailingSeparators(normalizePathSeparators(value)).toLowerCase();
}

function containsAmbientPrivateSegments(value: string): boolean {
  const segments = pathIdentity(value).split('/');
  for (let index = 0; index + 2 < segments.length; index++)
    if (
      segments[index] === '.pi' &&
      segments[index + 1] === 'agent' &&
      segments[index + 2] === LUMINARIES_IDENTITY.namespace.stateDirectory
    )
      return true;
  return false;
}

export function isPrivateDisplayReference(value: string, privatePaths: readonly string[]): boolean {
  const candidate = pathIdentity(value);
  if (containsAmbientPrivateSegments(candidate)) return true;
  return privatePaths.some((privatePath) => {
    const root = pathIdentity(privatePath);
    return !!root && (candidate === root || candidate.startsWith(`${root}/`));
  });
}

function pathCharacterMatches(left: string, right: string): boolean {
  if ((left === '/' || left === '\\') && (right === '/' || right === '\\')) return true;
  return left.toLowerCase() === right.toLowerCase();
}

function privateRootAt(value: string, index: number, root: string): number | undefined {
  if (!root || index + root.length > value.length) return undefined;
  for (let offset = 0; offset < root.length; offset++)
    if (!pathCharacterMatches(value[index + offset] ?? '', root[offset] ?? '')) return undefined;
  return index + root.length;
}

function isTextBoundary(character: string): boolean {
  return (
    !character ||
    character.trim() === '' ||
    character === '"' ||
    character === "'" ||
    character === '<' ||
    character === '>'
  );
}

function consumePrivateSuffix(value: string, end: number): number {
  if (value[end] !== '/' && value[end] !== '\\') return end;
  while (end < value.length && !isTextBoundary(value[end] ?? '')) end++;
  return end;
}

function scrubKnownPrivateRoots(value: string, privatePaths: readonly string[]): string {
  if (!privatePaths.length) return value;
  let result = '';
  let index = 0;
  while (index < value.length) {
    let matchedEnd: number | undefined;
    for (const root of privatePaths) {
      const end = privateRootAt(value, index, root);
      if (end !== undefined) {
        matchedEnd = consumePrivateSuffix(value, end);
        break;
      }
    }
    if (matchedEnd === undefined) {
      result += value[index] ?? '';
      index++;
    } else {
      result += PRIVATE_STATE_LABEL;
      index = matchedEnd;
    }
  }
  return result;
}

function scrubAmbientPrivateTokens(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    if (isTextBoundary(value[index] ?? '')) {
      result += value[index] ?? '';
      index++;
      continue;
    }
    let end = index + 1;
    while (end < value.length && !isTextBoundary(value[end] ?? '')) end++;
    const token = value.slice(index, end);
    result += containsAmbientPrivateSegments(token) ? PRIVATE_STATE_LABEL : token;
    index = end;
  }
  return result;
}

export function scrubPrivateDisplayReferences(value: string, privatePaths: readonly string[]): string {
  return scrubPreparedPrivateDisplayReferences(value, preparePrivateDisplayPaths(privatePaths));
}

function scrubPreparedPrivateDisplayReferences(value: string, privatePaths: readonly string[]): string {
  return scrubAmbientPrivateTokens(scrubKnownPrivateRoots(value, privatePaths));
}

function isWordCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === '_' ||
    character === '-'
  );
}

function secretAssignment(value: string, index: number): { start: number; end: number } | undefined {
  if (isWordCharacter(value[index - 1] ?? '')) return undefined;
  let keyEnd = index;
  while (isWordCharacter(value[keyEnd] ?? '')) keyEnd++;
  const key = value.slice(index, keyEnd);
  if (!key || !isDisplaySecretKey(key)) return undefined;
  let start = keyEnd;
  if (value[start] === '"' || value[start] === "'") start++;
  while (value[start]?.trim() === '') start++;
  if (value[start] === ':' || value[start] === '=') start++;
  else if (!key.startsWith('-') || start === keyEnd) return undefined;
  while (value[start]?.trim() === '') start++;
  const quote = value[start] === '"' || value[start] === "'" ? value[start] : undefined;
  if (quote) {
    start++;
    let end = start;
    while (end < value.length && value[end] !== quote) end += value[end] === '\\' ? 2 : 1;
    return end > start ? { start, end: Math.min(end, value.length) } : undefined;
  }
  const scheme = ['bearer ', 'basic '].find((candidate) =>
    value
      .slice(start, start + candidate.length)
      .toLowerCase()
      .startsWith(candidate),
  );
  let end = start + (scheme?.length ?? 0);
  while (end < value.length) {
    const character = value[end] ?? '';
    if (
      character.trim() === '' ||
      character === '"' ||
      character === "'" ||
      character === ',' ||
      character === ';' ||
      character === '&' ||
      character === '}' ||
      character === ']'
    )
      break;
    end++;
  }
  return end > start ? { start, end } : undefined;
}

/** Remove credential values while preserving the surrounding diagnostic structure. */
export function scrubDisplaySecrets(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const assignment = secretAssignment(value, index);
    if (assignment) {
      result += value.slice(index, assignment.start);
      result += '[secret]';
      index = assignment.end;
      continue;
    }
    const bearer = value.slice(index, index + 7).toLowerCase() === 'bearer ';
    if (bearer && !isWordCharacter(value[index - 1] ?? '')) {
      let end = index + 7;
      while (end < value.length && value[end]?.trim() !== '' && value[end] !== '"' && value[end] !== "'") end++;
      if (end > index + 7) {
        result += 'Bearer [secret]';
        index = end;
        continue;
      }
    }
    result += value[index] ?? '';
    index++;
  }
  return result;
}

/** Preserve ordinary Unicode, line breaks, and tabs while neutralizing terminal-shaping controls. */
export function scrubUnsafeTerminalControls(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code === undefined ||
      (code !== 0x09 &&
        code !== 0x0a &&
        (code <= 0x1f ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x061c ||
          code === 0x200e ||
          code === 0x200f ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)))
    )
      continue;
    result += character;
  }
  return result;
}

export function sanitizeDisplayText(value: string, privatePaths: readonly string[]): string {
  return sanitizePreparedDisplayText(value, preparePrivateDisplayPaths(privatePaths));
}

export function sanitizePreparedDisplayText(value: string, privatePaths: readonly string[]): string {
  return scrubUnsafeTerminalControls(
    scrubPreparedPrivateDisplayReferences(scrubDisplaySecrets(normalizeLineEndings(value)), privatePaths),
  );
}

export function normalizeLineEndings(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index] ?? '';
    if (character === '\r') {
      if (value[index + 1] === '\n') index++;
      result += '\n';
    } else result += character;
  }
  return result;
}

export function collapseWhitespace(value: string): string {
  let result = '';
  let pendingSpace = false;
  for (const character of value) {
    if (character.trim() === '') pendingSpace = result.length > 0;
    else {
      if (pendingSpace) result += ' ';
      result += character;
      pendingSpace = false;
    }
  }
  return result;
}

export function splitWhitespace(value: string): string[] {
  const collapsed = collapseWhitespace(value).trim();
  return collapsed ? collapsed.split(' ') : [];
}

export { isAsciiControlCharacter };
