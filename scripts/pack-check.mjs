import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DefaultPackageManager, SettingsManager, discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli || !isAbsolute(npmCli)) throw new Error('pack:check must run through npm');

const TOOL_NAMES = [
  'luminaries_await',
  'luminaries_control',
  'luminaries_directory',
  'luminaries_message',
  'luminaries_spawn',
];
const SKILL_PATH = 'skills/luminaries-collaboration/SKILL.md';
const GATE_DEADLINE = Date.now() + 175_000;
const passed = [];

function remainingMs() {
  const remaining = GATE_DEADLINE - Date.now();
  if (remaining < 1) throw new Error('Release package gate exceeded its 175-second internal deadline');
  return Math.min(150_000, remaining);
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: remainingMs(),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0)
    throw new Error(
      `${basename(command)} ${args[0] ?? ''} failed (${String(result.status)}):\n${result.stderr || result.stdout}`,
    );
  return result;
}

function npm(args, cwd, allowFailure = false) {
  return run(process.execPath, [npmCli, ...args], cwd, allowFailure);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return false;
    throw error;
  }
}

function packageManager(cwd, agentDir) {
  return new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });
}

function enabledPaths(resources) {
  return resources.filter((resource) => resource.enabled).map((resource) => resource.path);
}

async function loadStockExtension(extensionPath, cwd, agentDir) {
  const result = await discoverAndLoadExtensions([extensionPath], cwd, agentDir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  return result.extensions[0];
}

async function runtimeJavaScriptPaths(packageRoot) {
  const paths = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.js'))
        paths.push(relative(packageRoot, path).split(sep).join('/'));
    }
  };
  await visit(join(packageRoot, 'dist'));
  return paths.sort();
}

async function compilerOutputPaths(directory, excluded = new Set()) {
  const paths = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const outputPath = relative(directory, path).split(sep).join('/');
        if (!excluded.has(outputPath)) paths.push(outputPath);
      }
    }
  };
  await visit(directory);
  return paths.sort();
}

async function compileAndVerifyShippedOutput(staging) {
  const compiled = join(staging, 'compiled');
  run(
    process.execPath,
    [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(root, 'tsconfig.build.json'),
      '--outDir',
      compiled,
    ],
    root,
  );
  const shipped = join(root, 'dist');
  const compiledPaths = await compilerOutputPaths(compiled);
  const shippedPaths = await compilerOutputPaths(shipped, new Set(['luminaries-build.json']));
  assert.deepEqual(
    shippedPaths,
    compiledPaths,
    'Shipped compiler output must exactly match current source and tsconfig',
  );
  for (const path of compiledPaths) {
    const [compiledBytes, shippedBytes] = await Promise.all([
      readFile(join(compiled, ...path.split('/'))),
      readFile(join(shipped, ...path.split('/'))),
    ]);
    assert.equal(shippedBytes.equals(compiledBytes), true, `Shipped '${path}' is stale`);
  }
  return verifyManifest(root);
}

async function verifyManifest(packageRoot) {
  const text = await readFile(join(packageRoot, 'dist', 'luminaries-build.json'), 'utf8');
  const manifest = JSON.parse(text);
  assert.equal(manifest.version, 1);
  assert.equal(typeof manifest.buildId, 'string');
  assert.equal(manifest.buildId.length, 64);
  const expectedPaths = (await runtimeJavaScriptPaths(packageRoot)).sort();
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    expectedPaths,
  );
  const files = [];
  for (const file of manifest.files) {
    const bytes = await readFile(join(packageRoot, ...file.path.split('/')));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(file.sha256, sha256, `${file.path} must match the accepted build manifest`);
    files.push({ path: file.path, sha256 });
  }
  const buildId = createHash('sha256')
    .update(JSON.stringify({ version: 1, files }))
    .digest('hex');
  assert.equal(manifest.buildId, buildId);
  return { text, manifest };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForPort(port, child, stderr) {
  const deadline = Date.now() + Math.min(5_000, remainingMs());
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Git daemon exited before listening: ${stderr()}`);
    const connected = await new Promise((resolveConnected) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolveConnected(true);
      });
      socket.once('error', () => resolveConnected(false));
    });
    if (connected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('Git daemon did not open its loopback port');
}

async function stopChild(child) {
  if (!child) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  const firstExit = once(child, 'exit');
  child.kill();
  await Promise.race([firstExit, new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  if (!exited()) {
    const forcedExit = once(child, 'exit');
    child.kill('SIGKILL');
    await forcedExit;
  }
}

async function expectBuildRefusal(pool, agent) {
  await assert.rejects(
    pool.ensure(agent),
    (error) => error && typeof error === 'object' && Reflect.get(error, 'code') === 'runtime_build_mismatch',
  );
}

npm(['run', 'typecheck'], root);
passed.push('strict TypeScript');
npm(['run', 'format:check'], root);
passed.push('repository format');

const staging = await mkdtemp(join(tmpdir(), 'luminaries-release-package-'));
let gitDaemon;
let wavesManager;
let uninstallWaves;
const summary = {
  packageGraphs: {},
  packageFiles: 0,
  runtimeFiles: 0,
  buildId: '',
  tools: [],
  cleanup: {},
};

try {
  const sourceBuild = await compileAndVerifyShippedOutput(staging);
  passed.push('source-to-shipped compiler and manifest parity');

  const packed = npm(['pack', '--json', '--pack-destination', staging], root);
  const packResults = JSON.parse(packed.stdout);
  assert.equal(packResults.length, 1, 'npm pack must produce exactly one real tarball');
  const packResult = packResults[0];
  const archive = join(staging, packResult.filename);
  assert.equal(await exists(archive), true);
  const shippedPaths = packResult.files.map((file) => file.path).sort();
  assert.ok(shippedPaths.includes('LICENSE'));
  assert.ok(shippedPaths.includes('README.md'));
  assert.ok(shippedPaths.includes('docs/configuration.md'));
  assert.ok(shippedPaths.includes('docs/foundations.md'));
  assert.ok(shippedPaths.includes('docs/reference/README.md'));
  assert.ok(shippedPaths.includes('docs/usage.md'));
  assert.ok(shippedPaths.includes('package.json'));
  assert.ok(shippedPaths.includes('dist/extension.js'));
  assert.ok(shippedPaths.includes('dist/extension.d.ts'));
  assert.ok(shippedPaths.includes('dist/waves-v1.js'));
  assert.ok(shippedPaths.includes('dist/waves-v1.d.ts'));
  assert.ok(shippedPaths.includes('dist/luminaries-build.json'));
  assert.ok(shippedPaths.includes(SKILL_PATH));
  assert.equal(
    shippedPaths.every(
      (path) =>
        path === 'LICENSE' ||
        path === 'README.md' ||
        path === 'docs/configuration.md' ||
        path === 'docs/foundations.md' ||
        (path.startsWith('docs/reference/') && path.endsWith('.md')) ||
        path === 'docs/usage.md' ||
        (path.startsWith('docs/assets/') && path.endsWith('.png')) ||
        path === 'package.json' ||
        path === SKILL_PATH ||
        path.startsWith('dist/'),
    ),
    true,
  );
  summary.packageFiles = shippedPaths.length;
  for (const document of ['README.md', 'docs/usage.md']) {
    const markdown = await readFile(join(root, document), 'utf8');
    const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)];
    assert.ok(images.length > 0, `${document} must include its product screenshots`);
    for (const [, reference] of images) {
      const path = relative(root, resolve(root, dirname(document), reference))
        .split(sep)
        .join('/');
      assert.ok(shippedPaths.includes(path), `${document} image '${path}' must ship`);
    }
  }
  passed.push('real tarball contents');

  const workspace = join(staging, 'workspace');
  const localAgentDir = join(staging, 'local-agent');
  await mkdir(workspace, { recursive: true });
  const localPackages = packageManager(workspace, localAgentDir);
  await localPackages.install(root);
  const localResources = await localPackages.resolveExtensionSources([root]);
  assert.deepEqual(enabledPaths(localResources.extensions), [join(root, 'dist', 'extension.js')]);
  assert.deepEqual(enabledPaths(localResources.skills), [join(root, ...SKILL_PATH.split('/'))]);
  const sourceExtension = await loadStockExtension(
    enabledPaths(localResources.extensions)[0],
    workspace,
    localAgentDir,
  );
  assert.deepEqual([...sourceExtension.tools.keys()].sort(), TOOL_NAMES);
  summary.packageGraphs.local = { copied: false, installedDependencies: false, sourceCheckoutLoaded: true };
  passed.push('Pi local source graph');

  const installRoot = join(staging, 'managed');
  await mkdir(installRoot, { recursive: true });
  npm(['install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--prefix', installRoot, archive], staging);
  const hostPeerScope = join(installRoot, 'node_modules', '@earendil-works');
  await mkdir(hostPeerScope, { recursive: true });
  for (const name of ['pi-coding-agent', 'pi-tui'])
    await symlink(
      join(root, 'node_modules', '@earendil-works', name),
      join(hostPeerScope, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  const installedRoot = join(installRoot, 'node_modules', 'pi-luminaries');
  const installedPackage = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  const wavesConsumerEntry = join(installRoot, 'waves-consumer.mjs');
  await writeFile(wavesConsumerEntry, "export * from 'pi-luminaries/waves-v1';\n");
  assert.deepEqual(installedPackage.pi?.extensions, ['./dist/extension.js']);
  assert.deepEqual(installedPackage.pi?.skills, ['./skills']);
  assert.deepEqual(Object.keys(installedPackage.exports ?? {}).sort(), ['.', './waves-v1']);
  assert.equal(Object.keys(installedPackage.dependencies ?? {}).length, 0);
  assert.equal(await exists(join(installRoot, 'node_modules', 'typescript')), false);
  assert.equal(await exists(join(installRoot, 'node_modules', 'prettier')), false);
  assert.equal(await exists(join(installRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')), true);
  assert.equal(await exists(join(installRoot, 'node_modules', '@earendil-works', 'pi-tui')), true);
  summary.packageGraphs.managed = { devDependencies: false, hostPeers: true, binShim: false };
  passed.push('Pi managed-package graph');

  const gitWork = join(staging, 'git-work');
  const gitRoot = join(staging, 'git-server');
  const bareRepository = join(gitRoot, 'owner', 'pi-luminaries.git');
  await mkdir(gitWork, { recursive: true });
  await mkdir(dirname(bareRepository), { recursive: true });
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', gitWork], staging);
  run('git', ['init', '--initial-branch=main'], gitWork);
  run('git', ['config', 'user.name', 'Luminaries release gate'], gitWork);
  run('git', ['config', 'user.email', 'luminaries-release@example.invalid'], gitWork);
  run('git', ['config', 'core.autocrlf', 'false'], gitWork);
  run('git', ['add', '--all'], gitWork);
  run('git', ['commit', '-m', 'release package'], gitWork);
  run('git', ['clone', '--bare', gitWork, bareRepository], staging);
  const gitPort = await freePort();
  const gitExecPath = run('git', ['--exec-path'], staging).stdout.trim();
  const gitDaemonEntry = join(gitExecPath, process.platform === 'win32' ? 'git-daemon.exe' : 'git-daemon');
  let gitStderr = '';
  gitDaemon = spawn(
    gitDaemonEntry,
    ['--reuseaddr', '--export-all', '--listen=127.0.0.1', `--port=${gitPort}`, `--base-path=${gitRoot}`, gitRoot],
    { cwd: staging, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  gitDaemon.stderr.on('data', (chunk) => {
    gitStderr += chunk.toString();
  });
  await waitForPort(gitPort, gitDaemon, () => gitStderr);
  const gitSource = `git:git://127.0.0.1:${gitPort}/owner/pi-luminaries.git`;
  const gitAgentDir = join(staging, 'git-agent');
  const gitPackages = packageManager(workspace, gitAgentDir);
  const gitResources = await gitPackages.resolveExtensionSources([gitSource]);
  const gitInstalledRoot = gitPackages.getInstalledPath(gitSource, 'user');
  assert.ok(gitInstalledRoot);
  assert.deepEqual(enabledPaths(gitResources.extensions), [join(gitInstalledRoot, 'dist', 'extension.js')]);
  assert.deepEqual(enabledPaths(gitResources.skills), [join(gitInstalledRoot, ...SKILL_PATH.split('/'))]);
  assert.equal(await exists(join(gitInstalledRoot, 'node_modules', 'typescript')), false);
  assert.equal(await exists(join(gitInstalledRoot, 'node_modules', 'prettier')), false);
  summary.packageGraphs.git = {
    devDependencies: false,
    hostPiCodingAgent: await exists(join(gitInstalledRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')),
    hostPiTui: await exists(join(gitInstalledRoot, 'node_modules', '@earendil-works', 'pi-tui')),
  };
  passed.push('Pi Git package graph');

  const installedBuild = await verifyManifest(installedRoot);
  assert.equal(installedBuild.text, sourceBuild.text);
  summary.buildId = installedBuild.manifest.buildId;
  summary.runtimeFiles = installedBuild.manifest.files.length;
  const skill = await readFile(join(installedRoot, ...SKILL_PATH.split('/')), 'utf8');
  assert.match(skill, /^---\r?\nname: luminaries-collaboration\r?\n/u);
  passed.push('deterministic accepted build and progressive skill');

  const importProbe = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const waves = await import('pi-luminaries/waves-v1');
let privateCode;
try { await import('pi-luminaries/luminaries-manager'); } catch (error) { privateCode = error?.code; }
console.log(JSON.stringify({ waves: Object.keys(waves).sort(), privateCode }));`,
    ],
    installRoot,
  );
  const publicSurface = JSON.parse(importProbe.stdout.trim());
  assert.deepEqual(publicSurface, {
    waves: [
      'LUMINARIES_WAVES_SERVICE',
      'LUMINARIES_WAVES_SERVICE_VERSION',
      'currentWavesService',
      'isLuminariesWavesService',
    ],
    privateCode: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  passed.push('public exports only');

  const stockAgentDir = join(staging, 'stock-agent');
  const loadedExtension = await loadStockExtension(
    join(installedRoot, 'dist', 'extension.js'),
    workspace,
    stockAgentDir,
  );
  assert.deepEqual([...loadedExtension.tools.keys()].sort(), TOOL_NAMES);
  assert.deepEqual([...loadedExtension.commands.keys()], ['luminaries']);
  assert.equal(loadedExtension.messageRenderers.has('luminaries_protocol_message'), true);
  summary.tools = [...loadedExtension.tools.keys()].sort();
  passed.push('stock Pi extension load and five tools');

  const managerModule = await import(pathToFileURL(join(installedRoot, 'dist', 'luminaries-manager.js')).href);
  const bridgeModule = await import(pathToFileURL(join(installedRoot, 'dist', 'peer-bridge.js')).href);
  const wavesModule = await import(pathToFileURL(join(installedRoot, 'dist', 'waves-service.js')).href);
  const acceptedBuildModule = await import(pathToFileURL(join(installedRoot, 'dist', 'accepted-build.js')).href);
  const actorPoolModule = await import(pathToFileURL(join(installedRoot, 'dist', 'actor-pool.js')).href);
  const acceptedBuild = await acceptedBuildModule.loadAcceptedBuild();
  assert.ok(acceptedBuild);
  const wavesRoot = join(staging, 'waves-owner');
  const wavesSession = join(wavesRoot, 'parent.jsonl');
  await mkdir(wavesRoot, { recursive: true });
  await writeFile(wavesSession, '');
  wavesManager = new managerModule.LuminariesManager({
    sessionId: 'waves-package-session',
    sessionFile: wavesSession,
    cwd: wavesRoot,
    agentDir: join(wavesRoot, 'agent'),
    acceptedBuild,
    rootConfiguration: {
      maxOpenAgents: 10,
      maxDepth: 1,
      serviceGrant: ['spawn', 'directory', 'message', 'watch', 'steer', 'follow_up', 'interrupt'],
      extensions: { entries: [], allowedPaths: [] },
      sources: {
        maxOpenAgents: 'built-in',
        maxDepth: 'built-in',
        agentNames: 'built-in',
        serviceGrant: 'built-in',
      },
    },
  });
  await wavesManager.start();
  const rootId = wavesManager.store.snapshot().root.rootId;
  const childId = 'package-child';
  const childSessionDir = join(wavesRoot, 'child-session');
  await mkdir(childSessionDir, { recursive: true });
  await wavesManager.store.admitAgent(
    {
      agentId: childId,
      parentId: rootId,
      segment: childId,
      cwd: wavesRoot,
      sessionId: 'package-child-session',
      sessionDir: childSessionDir,
      displayName: 'Package child',
      assignment: 'Prove the shipped child gateway.',
      ownershipBoundary: 'Release package proof only.',
    },
    { kind: 'agent', agentId: rootId },
  );
  const claim = await wavesManager.store.claimRuntime(childId, process.pid, 'package-gate');
  const runtimeOwner = claim.value.runtimeOwner;
  await wavesManager.store.markRuntimeSpawned(childId, runtimeOwner, process.pid);
  await wavesManager.store.markRuntimeReady(childId, runtimeOwner, process.pid);
  const credential = wavesManager.bridge.issue(childId, {
    sessionId: 'package-child-session',
    generation: wavesManager.generationId,
    buildId: acceptedBuild.id,
  });
  assert.throws(
    () => wavesManager.bridge.bind(credential, { runtimeIdentity: { agentId: childId, runtimeOwner } }),
    /accepted package build/u,
  );
  await assert.rejects(
    bridgeModule.sendLuminariesBuildIdentity({ ...credential, buildId: '0'.repeat(64) }),
    /runtime_build_mismatch.*does not match its owner/u,
  );
  await bridgeModule.sendLuminariesBuildIdentity({ ...credential, buildId: acceptedBuild.id });
  wavesManager.bridge.bind(credential, { runtimeIdentity: { agentId: childId, runtimeOwner } });
  const childDirectory = await bridgeModule.sendLuminariesToolCall({
    ...credential,
    toolCallId: 'after-build',
    toolName: 'luminaries_directory',
    input: { action: 'list' },
  });
  assert.equal(childDirectory.details.capacity.used, 1);
  assert.notEqual(wavesManager.generationId, acceptedBuild.id);
  wavesManager.bridge.revoke(credential);
  assert.equal(wavesManager.bridge.activeCredentialCount, 0);
  await wavesManager.store.releaseRuntime(childId, runtimeOwner, 'runtime_parked', 'package_gate_complete');
  await wavesManager.store.closeAgent(childId, { kind: 'agent', agentId: rootId });
  const publicWaves = await import(pathToFileURL(wavesConsumerEntry).href);
  uninstallWaves = wavesModule.installWavesService(wavesManager);
  const wavesConsumer = publicWaves.currentWavesService();
  assert.ok(wavesConsumer);
  const wavesList = await wavesConsumer.directory();
  assert.equal(wavesList.details.action, 'list');
  const releaseSubscription = wavesConsumer.subscribe(() => undefined);
  releaseSubscription();
  await assert.rejects(
    wavesConsumer.directory({ action: 'inspect', agentId: childId }),
    /cannot inspect closed history/u,
  );
  uninstallWaves();
  uninstallWaves = undefined;
  await wavesManager.close();
  wavesManager = undefined;
  passed.push('authenticated child build binding and closed-target Waves refusal');

  for (const path of ['package.json', SKILL_PATH]) {
    const installedPath = join(installedRoot, path);
    const original = await readFile(installedPath);
    try {
      await writeFile(installedPath, Buffer.concat([original, Buffer.from('\n')]));
      await acceptedBuild.verify();
      const reloaded = await acceptedBuildModule.loadAcceptedBuild();
      assert.equal(reloaded.id, acceptedBuild.id, 'Documentation and metadata do not change runtime identity');
    } finally {
      await writeFile(installedPath, original);
    }
  }

  let bridgeIssueCount = 0;
  const buildAgent = { agentId: 'build-agent', lifecycle: 'open' };
  const buildPool = new actorPoolModule.LuminariesActorPool({
    store: { snapshot: () => ({ root: { rootId: 'root' }, agents: { [buildAgent.agentId]: buildAgent } }) },
    bridge: {
      issue: () => {
        bridgeIssueCount++;
        throw new Error('Build refusal reached credential creation');
      },
    },
    generation: 'package-gate',
    acceptedBuild,
    managerRunning: () => true,
    runExclusive: (_agentId, operation) => operation(),
    onDiagnostic: () => undefined,
  });
  const changedPath = join(installedRoot, 'dist', 'product-identity.js');
  const changedBytes = await readFile(changedPath);
  try {
    await writeFile(changedPath, Buffer.concat([changedBytes, Buffer.from('\n// changed during release gate\n')]));
    await expectBuildRefusal(buildPool, buildAgent);
  } finally {
    await writeFile(changedPath, changedBytes);
  }
  await acceptedBuild.verify();
  const addedPath = join(installedRoot, 'dist', 'package-update.js');
  try {
    await writeFile(addedPath, 'export const packageUpdate = true;\n');
    await expectBuildRefusal(buildPool, buildAgent);
  } finally {
    await rm(addedPath, { force: true });
  }
  await acceptedBuild.verify();
  const removedPath = join(installedRoot, 'dist', 'public-pagination.js');
  const heldPath = join(staging, 'held-public-pagination.js');
  try {
    await rename(removedPath, heldPath);
    await expectBuildRefusal(buildPool, buildAgent);
  } finally {
    await rename(heldPath, removedPath);
  }
  await acceptedBuild.verify();
  assert.equal(
    bridgeIssueCount,
    0,
    'build mismatch/update/removal must refuse before child credential or process input',
  );
  await buildPool.closeAll();
  passed.push('pre-launch build change/update/removal refusal');
} finally {
  uninstallWaves?.();
  await wavesManager?.close().catch(() => undefined);
  await stopChild(gitDaemon);
  await rm(staging, { recursive: true, force: true });
}

assert.equal(await exists(staging), false, 'release package staging must be removed');
summary.cleanup = {
  stagingRemoved: true,
  gitDaemonExited: !gitDaemon || gitDaemon.exitCode !== null || gitDaemon.signalCode !== null,
  managersClosed: true,
  credentials: 0,
};
passed.push('process, socket, credential, descriptor, lease, and staging cleanup');
process.stdout.write(`${JSON.stringify({ passed: passed.length, failed: 0, checks: passed, ...summary }, null, 2)}\n`);
