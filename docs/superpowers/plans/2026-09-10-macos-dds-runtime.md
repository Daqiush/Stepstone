# macOS DDS Runtime Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm install && npm start` prepare and run both DDS command-line programs on Apple Silicon and Intel macOS while preserving Windows behavior.

**Architecture:** Add a pure platform-path resolver, a guarded child-process runner, and a Node-based macOS installer that compiles the bundled DDS C++ sources into fingerprinted immutable directories and atomically switches a `current` symlink. Keep DDS protocols and bridge gameplay unchanged, expose real smoke checks, and ignore local macOS/npm artifacts.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, Apple Clang/C++20, existing DDS C++ sources, npm lifecycle scripts.

---

## File Structure

- Create `dds-paths.js`: resolve default platform/architecture/default/override paths and produce setup diagnostics.
- Create `dds-process.js`: run one DDS stdin/stdout process with guarded Promise settlement.
- Modify `dds-wrapper.js`: retain bridge/DDS serialization and parsing, delegate path selection and process execution.
- Create `scripts/dds-build.js`: discover sources, fingerprint builds, create compile commands, validate/stage/publish native programs.
- Create `scripts/install-dds.js`: macOS-only postinstall orchestration and user-facing failures.
- Create `scripts/smoke-dds.js`: exercise both resolved native DDS protocols with known deals.
- Create `scripts/smoke-server.js`: bounded server-startup verification that cleans up only its child.
- Create `test/dds-paths.test.js`: platform and override behavior.
- Create `test/dds-process.test.js`: success, nonzero exit, spawn failure, EPIPE, and single-settlement behavior.
- Create `test/dds-build.test.js`: deterministic discovery/fingerprint/cache/compile-plan/publication behavior.
- Create `test/dds-wrapper.test.js`: public result parsing through executable test processes.
- Modify `package.json` and `package-lock.json`: add `postinstall`, `test`, and DDS smoke scripts without new packages.
- Create `.gitmodules`: record the existing DDS gitlink's official public HTTPS source.
- Modify `.gitignore`: add macOS metadata, AppleDouble files, and npm debug logs; retain existing worktree and dependency exclusions.
- Modify `README.md`: document automatic Mac setup, Xcode prerequisite recovery, overrides, and verification.

## Chunk 1: Runtime Selection and Process Safety

### Task 1: Platform-aware DDS paths

**Files:**
- Create: `test/dds-paths.test.js`
- Create: `dds-paths.js`

- [ ] **Step 1: Write failing resolver tests**

Create exactly eight `node:test` cases with `node:assert/strict` and these inputs/assertions (the host-default case may be skipped only on a host other than Windows/macOS):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveDdsPaths, ddsSetupHint } = require('../dds-paths');
const ROOT = path.resolve('test-fixture-root');

test('Windows preserves the x64 executable layout for any Node architecture', () => {
  const actual = resolveDdsPaths({ rootDir: ROOT, platform: 'win32', arch: 'arm64', env: {} });
  assert.equal(actual.calc, path.join(ROOT, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_calc.exe'));
  assert.equal(actual.solve, path.join(ROOT, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_solve.exe'));
});

test('Apple Silicon uses the arm64 current runtime', () => {
  const actual = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'arm64', env: {} });
  assert.equal(actual.solve, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-arm64', 'Release', 'current', 'dds_solve'));
});

test('Intel Mac uses the x64 current runtime', () => {
  const actual = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'x64', env: {} });
  assert.equal(actual.calc, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-x64', 'Release', 'current', 'dds_calc'));
});

test('calc-only override is project-root relative and leaves solve at its default', () => {
  const actual = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'arm64', env: { DDS_CALC_PATH: 'tools/calc' } });
  assert.equal(actual.calc, path.join(ROOT, 'tools', 'calc'));
  assert.equal(actual.solve, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-arm64', 'Release', 'current', 'dds_solve'));
  assert.deepEqual(actual.overridden, { calc: true, solve: false });
});

test('solve-only absolute override leaves calc at its default', () => {
  const external = path.join(ROOT, 'external-solve');
  const actual = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'x64', env: { DDS_SOLVE_PATH: external } });
  assert.equal(actual.calc, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-x64', 'Release', 'current', 'dds_calc'));
  assert.equal(actual.solve, external);
  assert.deepEqual(actual.overridden, { calc: false, solve: true });
});

test('omitted runtime inputs use the host process values', { skip: !['win32', 'darwin'].includes(process.platform) }, () => {
  const actual = resolveDdsPaths({ rootDir: ROOT, env: {} });
  assert.equal(actual.platform, process.platform);
  assert.equal(actual.arch, process.arch);
});

test('unsupported Mac architecture is rejected', () => {
  assert.throws(() => resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'ppc', env: {} }), /unsupported.*ppc/i);
});

test('setup hint contains runtime identity, both paths, and recovery', () => {
  const resolved = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'arm64', env: {} });
  const hint = ddsSetupHint(resolved);
  assert.match(hint, /darwin.*arm64/is);
  assert.match(hint, /dds_calc/);
  assert.match(hint, /dds_solve/);
  assert.match(hint, /npm install/i);
});
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run: `node --test test/dds-paths.test.js`

Expected: FAIL because `../dds-paths` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

Export `resolveDdsPaths(options = {})` and `ddsSetupHint(resolvedPaths)`. Default `rootDir` to `__dirname`, `platform` to `process.platform`, `arch` to `process.arch`, and `env` to `process.env`; normalize `rootDir` to an absolute path. Preserve the Windows x64 directory for every Windows Node architecture; permit only `arm64` and `x64` on Darwin; return `{ calc, solve, overridden, platform, arch }`. Resolve relative override paths from `rootDir` and do not silently fall back when an override is present. `ddsSetupHint` returns one string containing platform, architecture, both resolved paths, and `Run npm install to prepare DDS`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/dds-paths.test.js`

Expected: exit code 0; `tests 8`, `pass 8`, `fail 0` on Windows/macOS.

- [ ] **Step 5: Commit the resolver**

```bash
git add dds-paths.js test/dds-paths.test.js
git commit -m "feat: resolve DDS binaries by platform"
```

### Task 2: Safe DDS child-process execution

**Files:**
- Create: `test/dds-process.test.js`
- Create: `dds-process.js`

- [ ] **Step 1: Write failing process behavior tests**

Create exactly five tests. The two real-process tests use Node itself as the stdin-driven executable:

```js
test('resolves stdout from a zero exit', async () => {
  const output = await runDdsProcess(process.execPath, "process.stdout.write('DDS OK')\n");
  assert.equal(output, 'DDS OK');
});

test('rejects with code and stderr from a nonzero exit', async () => {
  await assert.rejects(
    runDdsProcess(process.execPath, "process.stderr.write('broken'); process.exit(7)\n"),
    error => error.message.includes(process.execPath) && /code 7/.test(error.message) && /broken/.test(error.message),
  );
});
```

For the remaining three, construct a controlled child with `EventEmitter` instances for child/stdin/stdout/stderr and an `stdin.end` callback. Test (a) child `error` followed by `close`, (b) stdin `{ code: 'EPIPE' }` followed by `close`, and (c) code 9 with empty stderr. Track the assertion callback count, await one `setImmediate` after rejection, and assert it remains one. Each error assertion must include `C:\\missing\\dds.exe`; the EPIPE case must also include `stdin` and `EPIPE`.

- [ ] **Step 2: Run the process test and verify RED**

Run: `node --test test/dds-process.test.js`

Expected: FAIL because `../dds-process` does not exist.

- [ ] **Step 3: Implement the guarded runner**

Implement one `settle(error, stdout)` guard around a Promise. Immediately after `spawnImpl(programPath, [], { windowsHide: true })`, attach child `error`, stdin `error`, stdout/stderr `data`, and child `close` handlers before calling `stdin.end(input)`. Convert buffers to strings, reject nonzero closes with code and stderr, ignore events after first settlement, and include `programPath` in every error.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/dds-process.test.js`

Expected: exit code 0; `tests 5`, `pass 5`, `fail 0`, with no uncaught event.

- [ ] **Step 5: Commit the process runner**

```bash
git add dds-process.js test/dds-process.test.js
git commit -m "fix: handle DDS process failures safely"
```

### Task 3: Integrate paths and process runner into the wrapper

**Files:**
- Create: `test/dds-wrapper.test.js`
- Modify: `dds-wrapper.js`

- [ ] **Step 1: Write failing wrapper tests**

Use the exact dependency boundary `createDdsClient({ paths, runProcess, existsSync })`, where `paths` is `{ calc, solve, overridden, platform, arch }`, `runProcess(path, input)` returns a Promise of stdout text, and `existsSync(path)` returns a boolean. Create exactly five tests:

```js
const PATHS = {
  calc: '/fixtures/dds_calc', solve: '/fixtures/dds_solve',
  overridden: { calc: false, solve: false }, platform: 'darwin', arch: 'arm64',
};
const ONE_CARD_HANDS = { N: [{ suit: 'S', rank: 14 }], E: [], S: [], W: [] };

test('calc serializes 16 masks and parses a 5x4 table', async () => {
  let sent;
  const client = createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async (program, input) => { sent = { program, input }; return Array.from({ length: 20 }, (_, i) => i).join(' '); },
  });
  const table = await client.calcDDTable(ONE_CARD_HANDS);
  assert.equal(sent.program, PATHS.calc);
  assert.equal(sent.input.trim().split(/\s+/).length, 16);
  assert.equal(sent.input.trim().split(/\s+/)[0], String(1 << 14));
  assert.deepEqual(table, [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15],[16,17,18,19]]);
});

test('solve serializes position and parses score/cards', async () => {
  let input;
  const client = createDdsClient({ paths: PATHS, existsSync: () => true, runProcess: async (_program, value) => { input = value; return '3 2 0 14 2 13'; } });
  const result = await client.solveBoard({ trump: 'NT', trickLeader: 'W', trickPlayed: [{ suit: 'H', rank: 10 }], hands: ONE_CARD_HANDS });
  assert.match(input, /^4 3 1 1 10 /);
  assert.deepEqual(result, { score: 3, cards: [{ suit: 'S', rank: 14 }, { suit: 'D', rank: 13 }] });
});
```

The third test sets `existsSync: () => false` and asserts platform `darwin`, architecture `arm64`, the resolved calc path, and `npm install` in the rejection. The fourth returns only `1 2 3` for calc and expects `Unexpected DDS output length: 3`. The fifth returns an empty string for solve and expects `dds_solve: empty output`.

- [ ] **Step 2: Run the wrapper test and verify RED**

Run: `node --test test/dds-wrapper.test.js`

Expected: the test file loads the current wrapper, then all five cases fail first with `TypeError: createDdsClient is not a function` (not a fixture or protocol error).

- [ ] **Step 3: Refactor minimally without changing protocols**

Keep `handsToBitmasks`, `calcDDTable`, and `solveBoard` behavior. Add `createDdsClient` for testable dependencies, make the default export client use `resolveDdsPaths({ rootDir: __dirname })` and `runDdsProcess`, and replace direct `spawn` event handling. Check each resolved file before execution. Export the existing public functions plus the factory; do not change `server.js` call sites.

- [ ] **Step 4: Run runtime tests and verify GREEN**

Run: `node --test test/dds-paths.test.js test/dds-process.test.js test/dds-wrapper.test.js`

Expected: exit code 0; `tests 18`, `pass 18`, `fail 0` on Windows/macOS.

- [ ] **Step 5: Commit wrapper integration**

```bash
git add dds-wrapper.js test/dds-wrapper.test.js
git commit -m "feat: use cross-platform DDS runtime"
```

## Chunk 2: Automatic macOS Build and Atomic Publication

### Task 4: Source discovery, fingerprint, and cache planning

**Files:**
- Create: `test/dds-build.test.js`
- Create: `scripts/dds-build.js`

- [ ] **Step 1: Write failing pure build-planning tests**

Create exactly ten tests using `fs.mkdtempSync(path.join(os.tmpdir(), 'stepstone-dds-plan-'))`, with cleanup in `test.afterEach`. Build each fixture under `<tmp>/dds/library/src` plus Stepstone-owned CLI fixtures. The production CLI sources live under `<root>/native/dds-cli/`. Assert:

1. Recursive discovery returns lexically sorted absolute `.cpp` compile sources and sorted `{ absolutePath, relativePath }` fingerprint entries for every `.cpp`, `.hpp`, and `.h` under `library/src`, plus the selected CLI files; a `.cpp` under `<tmp>/test` is excluded.
2. Empty source discovery rejects with the source root.
3. A fixture missing any of the basenames `dds.cpp`, `calc_dd_table.cpp`, or `solve_board.cpp` rejects and names the missing unit.
4. Changing a header byte changes the 64-character lowercase SHA-256 fingerprint.
5. Changing a selected CLI source byte changes the fingerprint, while two identical calls produce the same fingerprint. Compile arguments that differ only because outputs use two different temporary staging directories produce the same fingerprint after canonicalization.
6. `createCompileArgs` for arm64 contains adjacent `-arch`, `arm64`; for x64 it contains `-arch`, `x86_64`. Both arrays contain `-std=c++20`, `-O3`, `-mtune=generic`, `-fPIC`, `-pthread`, one `-I`, every sorted library source, exactly one CLI source, `-o`, and the output path.
7. `readBuildManifest` returns parsed `{ version: 1, fingerprint, platform, arch, programs }` or `null` for missing/malformed JSON.
8. Matching manifest plus all required executable program files makes `isBuildCacheHit` true; missing file, present-but-non-executable file, wrong fingerprint, or missing required program makes it false.
9. `validateExecutable` follows a simulated symlink because it receives the result of `statSync`, accepts a regular file when injected `accessSync(path, X_OK)` succeeds, and rejects a directory/non-executable path.
10. `validateDdsOverrides(paths, deps)` accepts absolute or already-resolved relative overrides independently, accepts a simulated symlink target, and rejects a missing/non-executable override with the exact override path.

- [ ] **Step 2: Run the build test and verify RED**

Run: `node --test test/dds-build.test.js`

Expected: FAIL because `../scripts/dds-build` does not exist.

- [ ] **Step 3: Implement deterministic pure helpers**

Export focused functions with these exact contracts:

```js
discoverDdsSources({ sourceRoot, projectRoot, cliSources })
// => { compileSources: string[], fingerprintFiles: Array<{ absolutePath, relativePath }> }
createCompileArgs({ arch, includeDir, librarySources, cliSource, outputPath })
// => string[]
canonicalizeCompileArgs({ args, projectRoot, outputPath, programName })
// => string[], with checkout-local paths normalized and -o value replaced by <OUTPUT>/<programName>
computeBuildFingerprint({ files, platform, arch, compilerIdentity, compileArgsByProgram })
// files is Array<{ absolutePath, relativePath }>; returns 64-char hex string
validateExecutable(filePath, { platform = process.platform, statSync = fs.statSync, accessSync = fs.accessSync } = {})
// => true or throws an Error containing filePath
validateDdsOverrides(paths, { validateExecutableFn = validateExecutable } = {})
// calls validateExecutableFn(path) only where paths.overridden[name] is true;
// => { calc: boolean, solve: boolean }, or propagates an Error containing the invalid override path
readBuildManifest(activeDir, { readFileSync = fs.readFileSync } = {})
// => { version: 1, fingerprint, platform, arch, programs: string[] } | null
isBuildCacheHit({ activeDir, fingerprint, requiredPrograms, readManifestFn = readBuildManifest, validateExecutableFn = validateExecutable })
// => boolean
```

Use only built-in `fs`, `path`, and `crypto`. `discoverDdsSources` recursively collects all three header/source extensions for fingerprinting, adds only the supplied CLI files, rejects missing required units, and normalizes paths against `projectRoot`. Fingerprint each normalized relative path followed by raw file bytes in lexical order, then stable JSON for platform, architecture, compiler identity, and **canonical** compile argument arrays. `canonicalizeCompileArgs` converts source/include paths under `projectRoot` to `<PROJECT_ROOT>/<relative-posix-path>` and replaces the concrete argument immediately following `-o` with `<OUTPUT>/<programName>`; real `createCompileArgs` arrays with collision-safe staging paths are used only for compiler execution. Thus two staging directories or checkout locations with identical semantic inputs share a fingerprint. `validateExecutable` follows symlinks with `stat`, requires `isFile()`, and calls injected `accessSync(filePath, fs.constants.X_OK)` when `platform === 'darwin'`. Production `validateDdsOverrides` injects closures that call `validateExecutable` with Darwin semantics; tests inject a recording validator. Production `isBuildCacheHit` similarly injects a Darwin validator, returns `false` rather than throwing for a bad cached artifact, and tests inject a validator that rejects a present-but-non-executable file.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/dds-build.test.js`

Expected: exit code 0; `tests 10`, `pass 10`, `fail 0`.

- [ ] **Step 5: Commit build planning**

```bash
git add scripts/dds-build.js test/dds-build.test.js
git commit -m "feat: plan reproducible macOS DDS builds"
```

### Task 5: Compile, stage, smoke-check, and publish atomically

**Files:**
- Modify: `test/dds-build.test.js`
- Modify: `scripts/dds-build.js`
- Create: `scripts/smoke-dds.js`

- [ ] **Step 1: Add failing orchestration/publication tests**

Add exactly nine tests. Compilation/staging tests use the real temporary filesystem with an injected no-op compiler runner that writes expected output fixtures. Publication and rollback tests use only a deterministic `createFsHarness()` adapter, so they never request Windows symlink privileges. The adapter stores directories, files, and symlink targets in Maps plus an ordered event log and implements exactly `mkdirSync`, `mkdtempSync`, `writeFileSync`, `readFileSync`, `chmodSync`, `statSync`, `accessSync`, `existsSync`, `renameSync`, `symlinkSync`, `readlinkSync`, `unlinkSync`, and `rmSync`. Verify:

1. Both unoverridden programs compile into the same unique staging directory before any publication event.
2. `{ overridden: { calc: true, solve: false } }` compiles/smokes/publishes only `dds_solve`; invert it for a sub-assertion covering calc.
3. Runner result `{ status: 1, stdout: '', stderr: 'compile broke', error: null }` rejects with diagnostics, removes staging, and leaves `readlinkSync(current)` at `builds/old`.
4. Rejected async `smokeCalc`/`smokeSolve` removes staging and leaves `current` at `builds/old`.
5. Success event order is compile both → chmod both → validate both → await smoke both → write manifest → rename staging → create temporary symlink → rename temporary symlink over `current`.
6. Publication renames staging to `Release/builds/<fingerprint>` and returns `{ buildDir, activeDir: current }`; an already-existing valid same-fingerprint build is validated and reused.
7. After switching `current`, both final paths are validated through `current`; a post-switch verification failure atomically restores the captured old symlink target and rejects.
8. If symlink creation/rename fails before the switch, `current` retains the old target and the error names the publication path.
9. On a first install where `current` is absent, publication creates it successfully; if post-switch validation fails, rollback removes the newly installed `current` link with `unlinkSync` and restores the original no-active-runtime state.

- [ ] **Step 2: Run the focused orchestration tests and verify RED**

Run: `node --test test/dds-build.test.js`

Expected: the original ten tests remain green and the nine new tests fail first with `TypeError: buildMacDds is not a function` or `TypeError: publishBuild is not a function`; no test fails because real Windows symlink permission is needed.

- [ ] **Step 3: Implement build orchestration**

Implement both functions as asynchronous functions because smoke checks return Promises:

```js
await buildMacDds({
  rootDir, arch, compilerPath, compilerIdentity,
  paths, overridden, sourcePlan, fingerprint, releaseDir,
  runCommand, smokeCalc, smokeSolve, fsOps,
});
// => { fingerprint, buildDir, activeDir, compiledPrograms: string[] }

await publishBuild({
  stagingDir, releaseDir, fingerprint, requiredPrograms,
  validateExecutable, fsOps,
});
// => { buildDir: `${releaseDir}/builds/${fingerprint}`, activeDir: `${releaseDir}/current` }
```

`runCommand(command, args, options)` is synchronous and returns `{ status: number|null, stdout: string, stderr: string, error: Error|null }`. `fsOps` is the exact adapter listed in Step 1, defaulting to Node `fs` methods. Use `mkdtempSync(path.join(releaseDir, '.staging-'))`, compiler argument arrays (never shell strings), and mode `0o755`. Compile all selected programs, then await all selected smoke functions against staged absolute paths. Write manifest `{ version: 1, fingerprint, platform: 'darwin', arch, programs: compiledPrograms }` and publish only after the full selected set passes.

`publishBuild` captures the old `current` symlink target when it exists (otherwise records `null`), validates/reuses a concurrent identical build or renames staging into place, creates a same-directory temporary relative symlink to `builds/<fingerprint>`, and renames it over `current`. It then validates every required default program through `current`. On post-switch failure with an old target it creates another temporary symlink to that target and atomically renames it over `current`; with no old target it removes only the newly created `current` symlink. A `try/finally` removes only the owned staging path or uninstalled temporary symlink; it never removes the prior active build.

- [ ] **Step 4: Implement reusable DDS smoke checks**

`scripts/smoke-dds.js` exports async `smokeCalc(calcPath)` and `smokeSolve(solvePath)`. Define this exact full deal:

```js
const FULL_DEAL = {
  N: Array.from({ length: 13 }, (_, i) => ({ suit: 'S', rank: i + 2 })),
  E: Array.from({ length: 13 }, (_, i) => ({ suit: 'H', rank: i + 2 })),
  S: Array.from({ length: 13 }, (_, i) => ({ suit: 'D', rank: i + 2 })),
  W: Array.from({ length: 13 }, (_, i) => ({ suit: 'C', rank: i + 2 })),
};
```

`smokeCalc` creates a client whose calc path is `calcPath`, uses real `runDdsProcess`/`fs.existsSync`, calls `calcDDTable(FULL_DEAL)`, and requires 5 rows x 4 integer values, each from 0 through 13. `smokeSolve` creates a client whose solve path is `solvePath`, calls `solveBoard({ trump: 'NT', trickLeader: 'N', trickPlayed: [], hands: FULL_DEAL })`, and requires integer score 0–13 plus at least one returned card contained in `FULL_DEAL.N`. When executed directly, resolve the default paths, await `Promise.all([smokeCalc(paths.calc), smokeSolve(paths.solve)])`, print success, or print the failing program path and set exit code 1. The direct entry point must use an async `main().catch(...)`; it must not launch unawaited Promises.

- [ ] **Step 5: Run the build tests and verify GREEN**

Run: `node --test test/dds-build.test.js`

Expected: exit code 0; `tests 19`, `pass 19`, `fail 0`.

- [ ] **Step 6: Commit build execution**

```bash
git add scripts/dds-build.js scripts/smoke-dds.js test/dds-build.test.js
git commit -m "feat: build and publish macOS DDS binaries"
```

### Task 6: Wire automatic installation into npm

**Files:**
- Create: `test/install-dds.test.js`
- Create: `scripts/install-dds.js`
- Create: `.gitmodules`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing installer tests**

Create exactly ten tests for this asynchronous interface:

```js
await installDds({
  platform, arch, env, rootDir, logger,
  deps: {
    resolveDdsPaths, validateDdsOverrides, ensureDdsSource, runCommand,
    discoverDdsSources, createCompileArgs, canonicalizeCompileArgs, computeBuildFingerprint,
    isBuildCacheHit, buildMacDds,
  },
});
// => { status: 'skipped'|'overridden'|'cached'|'built', paths, fingerprint?: string }
```

`runCommand(command, args)` has result shape `{ status, stdout, stderr, error }` from Task 5. Dependency functions default to production implementations; tests supply recording fakes and assert call order. Cover:

1. `win32` and Linux subcases return `skipped`, log once, and never resolve compiler/discover/build.
2. Darwin rejects `ppc` before compiler discovery.
3. Two valid overrides return `overridden` and skip source/compiler/cache/build.
4. An invalid override rejects with its path before compiler discovery.
5. One valid calc override discovers/builds only solve and passes `{ calc: true, solve: false }` into `buildMacDds`.
6. Missing DDS source in a Git checkout calls `git submodule update --init --recursive -- dds`, then continues only if `dds/library/src` exists.
7. Missing DDS source with failed initialization, or in a source archive without Git metadata, rejects with `dds/library/src`, the scoped initialization command, and underlying diagnostics before compilation.
8. Darwin calls `xcrun --find clang++`, then the returned compiler with `--version`, and passes joined path/version identity into fingerprinting.
9. Missing `xcrun` or compiler returns an error containing `xcode-select --install`.
10. A cache hit returns `cached` without `buildMacDds`; a build miss returning success yields `built`, while a nested sub-assertion confirms build stderr and architecture survive rejection.

- [ ] **Step 2: Run the installer tests and verify RED**

Run: `node --test test/install-dds.test.js`

Expected: FAIL because `../scripts/install-dds` does not exist.

- [ ] **Step 3: Implement the postinstall entry point**

Export async `installDds` and `ensureDdsSource`. Resolve paths first, validate overrides, then on Darwin ensure sources, locate the compiler, discover inputs, evaluate the cache, and await `buildMacDds` on a miss. `ensureDdsSource({ rootDir, runCommand, existsSync })` returns immediately when `dds/library/src` exists; otherwise, if root Git metadata exists, it runs exactly `git submodule update --init --recursive -- dds` in `rootDir` and rechecks the source directory. It rejects with the command and captured stderr if initialization fails or sources remain absent. The direct entry point must be:

```js
async function main() {
  await installDds();
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[DDS install] ${error.message}`);
    process.exitCode = 1;
  });
}
```

This ensures npm waits for compilation/smoke validation and receives a nonzero result. Print one actionable error and preserve compiler diagnostics.

- [ ] **Step 4: Record a publicly reproducible DDS gitlink source**

Create `.gitmodules` and pin `dds` to a commit reachable from the official public remote. Keep the Stepstone-specific CLI adapters in `native/dds-cli/` so the submodule no longer depends on a local-only commit:

```ini
[submodule "dds"]
	path = dds
	url = https://github.com/dds-bridge/dds.git
```

This URL is derived from the nested repository's existing `origin` and changed to its public HTTPS form so a Mac without GitHub SSH credentials can initialize it.

- [ ] **Step 5: Add npm scripts and refresh the lockfile**

Set:

```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js",
    "postinstall": "node scripts/install-dds.js",
    "test": "node --test test/*.test.js",
    "test:dds:smoke": "node scripts/smoke-dds.js"
  }
}
```

Run `npm install --package-lock-only --ignore-scripts` to update root package metadata without triggering a build on Windows.

- [ ] **Step 6: Verify installer and full Node suite**

Run: `node --test test/install-dds.test.js`

Expected: exit code 0; `tests 10`, `pass 10`, `fail 0`.

Run: `npm test`

Expected: exit code 0; `tests 48`, `pass 48`, `fail 0` (1 legacy + 18 runtime + 19 build + 10 installer).

- [ ] **Step 7: Commit npm integration**

```bash
git add .gitmodules scripts/install-dds.js test/install-dds.test.js package.json package-lock.json
git commit -m "feat: build DDS during macOS npm install"
```

## Chunk 3: Ignore Rules, Documentation, and Verification

### Task 7: Add a bounded server startup smoke check

**Files:**
- Create: `test/smoke-server.test.js`
- Create: `scripts/smoke-server.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing server-smoke tests**

Create two tests for async `smokeServer({ rootDir, timeoutMs = 10000, spawnImpl, setTimer, clearTimer, env })`. Use an EventEmitter child fixture with stdout/stderr emitters, `kill()` recording, and a `close` event. The success test emits `Stepstone 桥牌服务器已启动`, verifies spawn used `process.execPath`, `['server.js']`, `cwd: rootDir`, and `PORT: '0'`, then verifies exactly that child was killed and awaited through close. The timeout test fires the injected timer, verifies rejection contains `10000ms` plus captured stderr, and verifies the same child is killed once. No global process-name or port-based termination is allowed.

- [ ] **Step 2: Run the server-smoke test and verify RED**

Run: `node --test test/smoke-server.test.js`

Expected: exit code 1 with `MODULE_NOT_FOUND` for `../scripts/smoke-server`.

- [ ] **Step 3: Implement the bounded smoke harness**

Export `smokeServer` with production defaults `rootDir = path.resolve(__dirname, '..')`, `timeoutMs = 10000`, `spawnImpl = childProcess.spawn`, `setTimer = setTimeout`, `clearTimer = clearTimeout`, and `env = {}`. Spawn `process.execPath` with `['server.js']`, `{ cwd: rootDir, env: { ...process.env, ...env, PORT: '0' }, windowsHide: true }`; collect stdout/stderr; start the timer; on matching `/Stepstone .*服务器已启动/`, child error, early exit, or timeout, clear the timer and settle once. On success or failure, call `child.kill()` only for that child if it has not exited and await its `close` event before resolving/rejecting. Define `async function main() { await smokeServer(); }` and, only when `require.main === module`, call `main().catch(error => { console.error(error.message); process.exitCode = 1; })` so the npm command needs no arguments and awaits cleanup.

- [ ] **Step 4: Run the focused and full suites**

Add `"test:server:smoke": "node scripts/smoke-server.js"` to `package.json`, then run `npm install --package-lock-only --ignore-scripts` so the Task 7 commit never advertises the command before its target exists.

Run: `node --test test/smoke-server.test.js`

Expected: exit code 0; `tests 2`, `pass 2`, `fail 0`.

Run: `npm test`

Expected: exit code 0; `tests 50`, `pass 50`, `fail 0`.

- [ ] **Step 5: Commit the server smoke harness**

```bash
git add scripts/smoke-server.js test/smoke-server.test.js package.json package-lock.json
git commit -m "test: add bounded server startup smoke check"
```

### Task 8: Update `.gitignore` and Mac setup documentation

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Add focused ignore rules**

Retain the existing entries and add:

```gitignore
# macOS metadata
.DS_Store
._*

# npm diagnostics
npm-debug.log*
```

Do not add a broad `*.log` rule. Confirm `dds/.gitignore` already ignores `Build/bin`, so generated Darwin builds remain ignored by the nested DDS repository without modifying the user's `dds/build_calc.bat` or unrelated nested files.

- [ ] **Step 2: Document the Mac workflow and DDS source provisioning**

Add a concise README section covering:

- Ordinary clones can run `npm install`; on Mac, postinstall initializes the recorded public DDS submodule when its source is absent. `git clone --recurse-submodules` remains the explicit/preferred clone option.
- Source archives must include the `dds` directory because they have no Git metadata for initialization.
- `npm install && npm start` on Intel/Apple Silicon.
- Xcode Command Line Tools prerequisite and `xcode-select --install` recovery.
- `DDS_CALC_PATH` and `DDS_SOLVE_PATH`, including project-root-relative semantics.
- `npm run test:dds:smoke` and `npm run test:server:smoke` diagnosis.
- Existing Windows setups continue using local `dds/Build/bin/x64/Release/*.exe`; a fresh Windows clone must supply/build DDS separately because postinstall only builds on macOS.

- [ ] **Step 3: Verify ignored artifacts in the correct repositories**

Run:

```bash
git check-ignore -v .DS_Store npm-debug.log
git -C dds check-ignore -v Build/bin/darwin-arm64/Release/current/dds_calc
```

Expected: root `.gitignore` matches the first two paths and `dds/.gitignore` matches the generated binary path.

- [ ] **Step 4: Commit docs and ignore rules**

```bash
git add .gitignore README.md
git commit -m "docs: explain macOS DDS setup"
```

### Task 9: Final regression and platform acceptance

**Files:**
- Modify only if a verification failure exposes a defect covered by the approved spec.

- [ ] **Step 1: Run syntax checks**

Run:

```bash
node --check dds-paths.js
node --check dds-process.js
node --check dds-wrapper.js
node --check scripts/dds-build.js
node --check scripts/install-dds.js
node --check scripts/smoke-dds.js
node --check scripts/smoke-server.js
```

Expected: every command exits zero with no output.

- [ ] **Step 2: Run all automated tests**

Run: `npm test`

Expected: exit code 0; `tests 50`, `pass 50`, `fail 0`, with no uncaught process errors.

- [ ] **Step 3: Verify Windows compatibility in this workspace**

Run: `node scripts/install-dds.js`

Expected: reports that native installation is skipped on Windows and exits zero.

Run: `npm run test:dds:smoke`

Expected: PASS if the existing Windows `.exe` artifacts are present; otherwise an actionable missing-binary error, recorded as an environment limitation rather than hidden.

- [ ] **Step 4: Run the bounded server startup check**

Run: `npm run test:server:smoke`

Expected: within 10 seconds it observes `Stepstone 桥牌服务器已启动`, terminates only the child it spawned, and exits zero.

- [ ] **Step 5: Inspect the complete feature diff and nested DDS state**

Use the design commit as the fixed base:

```bash
git diff --check e1999b8..HEAD
git diff --stat e1999b8..HEAD
git diff --name-status e1999b8..HEAD
git status --short
git -C dds status --short
```

Expected: whitespace check exits zero; the range contains only planned files; both isolated worktrees are clean. In the user's original workspace, the pre-existing `build_calc.bat` modification remains untouched.

- [ ] **Step 6: Run mandatory real-Mac acceptance**

On both Apple Silicon and Intel macOS, start from an ordinary fresh clone without `--recurse-submodules` so automatic source provisioning is exercised, then run:

```bash
uname -m
node -p "process.arch"
npm install
npm test
node -e "console.log(require('./dds-paths').resolveDdsPaths({ rootDir: __dirname }))"
npm run test:dds:smoke
npm run test:server:smoke
```

Expected: `uname -m`/Node architecture and resolved `darwin-arm64` or `darwin-x64` path agree; install initializes DDS and compiles or reuses the correct architecture; `tests 50`, `pass 50`, `fail 0`; both DDS protocols pass; bounded server startup passes. Record outputs from both architectures and do not claim full Mac verification until both exist.

- [ ] **Step 7: Commit any verification-only correction and request review**

If no correction was required, leave history unchanged. Otherwise commit only the tested correction with a focused message, rerun all checks, then use superpowers:requesting-code-review before completion.
