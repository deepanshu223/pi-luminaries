import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_FILE = 'luminaries-build.json';
const PACKAGE_FILE = 'package.json';
const SKILL_FILE = 'skills/luminaries-collaboration/SKILL.md';

interface BuildFile {
  path: string;
  sha256: string;
}

interface BuildManifest {
  version: 1;
  buildId: string;
  files: readonly BuildFile[];
}

export interface AcceptedBuild {
  readonly id: string;
  verify(): Promise<void>;
}

/** Release builds are immutable; source-loaded tests do not claim a package build identity. */
export async function loadAcceptedBuild(moduleUrl = import.meta.url): Promise<AcceptedBuild | undefined> {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  if (basename(moduleDirectory) !== 'dist') return undefined;
  const packageRoot = dirname(moduleDirectory);
  const manifestPath = join(moduleDirectory, MANIFEST_FILE);
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(JSON.parse(manifestText));
  const verify = (): Promise<void> => verifyBuild(packageRoot, manifest, manifestText);
  await verify();
  return Object.freeze({ id: manifest.buildId, verify });
}

async function verifyBuild(packageRoot: string, manifest: BuildManifest, acceptedManifest: string): Promise<void> {
  const manifestPath = join(packageRoot, 'dist', MANIFEST_FILE);
  if ((await readFile(manifestPath, 'utf8')) !== acceptedManifest)
    throw new Error('Luminaries package build manifest changed while this root was running');
  const runtimeFiles = await runtimePaths(packageRoot);
  if (
    runtimeFiles.length !== manifest.files.length ||
    runtimeFiles.some((path, index) => path !== manifest.files[index]?.path)
  )
    throw new Error('Luminaries package runtime files do not match the accepted build manifest');
  const measured: BuildFile[] = [];
  for (const file of manifest.files) {
    const bytes = await readFile(resolveManifestPath(packageRoot, file.path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== file.sha256) throw new Error(`Luminaries package file '${file.path}' changed after root startup`);
    measured.push({ path: file.path, sha256 });
  }
  if (buildId(measured) !== manifest.buildId) throw new Error('Luminaries package build identity is invalid');
}

async function runtimePaths(packageRoot: string): Promise<string[]> {
  const distRoot = join(packageRoot, 'dist');
  const paths = [PACKAGE_FILE, SKILL_FILE];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.js'))
        paths.push(relative(packageRoot, path).split(sep).join('/'));
    }
  };
  await visit(distRoot);
  return paths.sort();
}

function parseManifest(value: unknown): BuildManifest {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'buildId', 'files']) || value.version !== 1)
    throw new Error('Luminaries package build manifest is invalid');
  if (!isSha256(value.buildId) || !Array.isArray(value.files) || value.files.length < 3)
    throw new Error('Luminaries package build manifest is invalid');
  const files = value.files.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['path', 'sha256']) ||
      !validManifestPath(entry.path) ||
      !isSha256(entry.sha256)
    )
      throw new Error('Luminaries package build manifest contains an invalid file');
    return { path: entry.path, sha256: entry.sha256 };
  });
  for (let index = 1; index < files.length; index++) {
    const previous = files[index - 1];
    const current = files[index];
    if (!previous || !current || previous.path >= current.path)
      throw new Error('Luminaries package build manifest files are not uniquely sorted');
  }
  return { version: 1, buildId: value.buildId, files };
}

function resolveManifestPath(packageRoot: string, path: string): string {
  const resolved = resolve(packageRoot, ...path.split('/'));
  const prefix = `${resolve(packageRoot)}${sep}`;
  if (!resolved.startsWith(prefix)) throw new Error('Luminaries package build manifest escapes its package root');
  return resolved;
}

function validManifestPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function buildId(files: readonly BuildFile[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, files }))
    .digest('hex');
}

function isSha256(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 64) return false;
  for (const character of value) if (!'0123456789abcdef'.includes(character)) return false;
  return true;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
