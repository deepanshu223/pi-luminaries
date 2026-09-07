import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const paths = ['package.json', 'skills/luminaries-collaboration/SKILL.md'];

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && entry.name.endsWith('.js')) paths.push(relative(root, path).split(sep).join('/'));
  }
}

await visit(dist);
paths.sort();
const files = [];
for (const path of paths) {
  const bytes = await readFile(join(root, ...path.split('/')));
  files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const buildId = createHash('sha256')
  .update(JSON.stringify({ version: 1, files }))
  .digest('hex');
await writeFile(join(dist, 'luminaries-build.json'), `${JSON.stringify({ version: 1, buildId, files }, null, 2)}\n`);
