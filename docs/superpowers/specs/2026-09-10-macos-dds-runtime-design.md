# macOS DDS Runtime Design

## Goal

Allow Stepstone to run with full DDS functionality when `node server.js` is launched on either Apple Silicon or Intel macOS. A normal `npm install` should prepare the native DDS command-line programs automatically, while preserving the existing Windows behavior.

## Root Cause

`dds-wrapper.js` currently hard-codes these Windows-only paths:

- `dds/Build/bin/x64/Release/dds_calc.exe`
- `dds/Build/bin/x64/Release/dds_solve.exe`

macOS cannot execute PE `.exe` files and the wrapper has no platform-aware lookup. The bundled DDS source and its upstream build configuration support macOS, so the missing layer is Stepstone-specific native CLI compilation and runtime selection.

## Scope

This change covers the Node.js server running natively on macOS. It includes both DDS operations used by Stepstone:

- `calcDDTable(hands)` for the full double-dummy table.
- `solveBoard(deal)` for per-position optimal defense in problem mode.

It does not move DDS into the browser, change bridge rules, change DDS input/output formats, or introduce Docker. Windows continues to use the existing `.exe` files and build process.

## Architecture

### Platform-aware binary resolver

A focused resolver module will map a platform and CPU architecture to the two DDS program paths. The default layouts will be:

- Windows on every Node architecture: `dds/Build/bin/x64/Release/dds_calc.exe` and `dds_solve.exe`. This deliberately preserves the current wrapper's architecture-independent Windows lookup; the change will not newly reject `win32/arm64` or `win32/ia32`.
- macOS arm64: `dds/Build/bin/darwin-arm64/Release/current/dds_calc` and `dds_solve`.
- macOS x64: `dds/Build/bin/darwin-x64/Release/current/dds_calc` and `dds_solve`.

`DDS_CALC_PATH` and `DDS_SOLVE_PATH` will override the defaults independently. Absolute override paths are used as written; relative override paths are resolved against the Stepstone project root, not the caller's current working directory. Overrides make local development, custom packaging, and unusual installation layouts possible without changing source code.

The resolver will be independently testable by accepting explicit platform, architecture, environment, and project-root inputs. Production callers will use `process.platform`, `process.arch`, `process.env`, and the Stepstone root.

### Automatic macOS installer

`package.json` will run a Node-based installer from `postinstall`. On macOS, the installer will:

1. Detect `arm64` or `x64` and reject other architectures with an actionable message.
2. Resolve and validate environment overrides before inspecting the DDS source. A valid override is an existing executable regular file, or a symlink whose target is an existing executable regular file. A valid override is never rebuilt. An invalid override fails installation instead of silently selecting another program. If both programs have valid overrides, installation skips source discovery and compilation entirely; if only one is overridden, only the unoverridden default program is built.
3. locate Apple Clang through `xcrun --find clang++`.
4. Discover compilation inputs by recursively walking only `dds/library/src`, selecting `.cpp` files, normalizing their project-relative paths, and sorting them lexically. The build must fail before invoking the compiler if discovery is empty or the required `dds.cpp`, `calc_dd_table.cpp`, and `solve_board.cpp` units are absent.
5. Compute a SHA-256 build fingerprint over all sorted `.cpp`, `.hpp`, and `.h` paths and contents under `dds/library/src`, the selected CLI source contents, platform, architecture, compiler identity/version, and compilation arguments. The installer checks the fingerprint before compiling. An unoverridden runtime is reused only when the active manifest has the same fingerprint and every required default program is executable. Missing or mismatched manifests force a rebuild.
6. On a cache miss, compile the discovered sources together with each unoverridden Stepstone CLI entry point. The command uses `-std=c++20 -O3 -mtune=generic -fPIC -pthread`, `-I <project>/dds/library/src`, and `-arch arm64` or `-arch x86_64` matching `process.arch`.
7. Stage the complete set of unoverridden outputs in a collision-safe sibling directory. Apply executable permissions, verify the files, run their smoke protocols, and write the fingerprint manifest while the directory is still private. Any failure removes only that staging directory and leaves the active runtime untouched.
8. Publish the verified set without exposing a partial installation: rename the staging directory to the immutable `Release/builds/<fingerprint>` directory, create a temporary `current` symlink pointing to that complete build, and atomically rename the symlink over the previous `current` symlink. The wrapper reads through `current`, so both programs switch together in one filesystem operation. A concurrent installer that already published the same fingerprint is validated and reused. Older immutable build directories may remain as a safe rollback/cache and are not part of runtime selection.
9. Verify that each final resolved program exists and is executable after the `current` switch.

The installer will not edit or invoke `dds/build_calc.bat`. On Windows and non-macOS platforms it will leave current installation behavior unchanged.

The only unavoidable macOS prerequisite is Xcode Command Line Tools. If `xcrun` or `clang++` is unavailable, `npm install` will fail with a concise explanation and the exact `xcode-select --install` recovery command.

### DDS wrapper integration

`dds-wrapper.js` will obtain both program paths from the resolver instead of constructing Windows-only constants. The existing stdin protocols and output parsing remain unchanged.

Before spawning a program, the wrapper will report an error containing the current platform, architecture, resolved path, and the recovery action.

Process execution will be isolated behind `runDdsProcess(programPath, input, spawnImpl = childProcess.spawn)`, which resolves with captured stdout only after exit code zero and rejects with contextual stderr for every other outcome. It attaches child `error`, stdin `error`, stdout/stderr listeners, and the `close` listener before writing input. A single internal settlement guard ensures that child `error`, stdin `EPIPE`, and a later `close` event cannot resolve or reject the Promise more than once. `calcDDTable` and `solveBoard` retain responsibility only for creating input and parsing successful output.

Classic mode already treats full-table calculation as optional and logs a failure. Problem mode already falls back to its existing non-DDS defense path when solving fails. Those behaviors remain unchanged; a successful macOS installation restores the intended DDS results.

## Data Flow

During installation:

`npm install` → `postinstall` → platform/override validation → Apple Clang and source discovery → fingerprint/cache evaluation → optional DDS compilation and staging → atomic `current` switch → architecture-specific native programs.

At runtime:

`server.js` → `dds-wrapper.js` → platform-aware resolver → native `dds_calc` or `dds_solve` → existing stdout parser → bridge engine.

## Error Handling

- Unsupported Mac CPU: stop installation and name the detected architecture.
- Missing DDS source/submodule: stop installation and explain that the DDS directory must be initialized.
- Missing Xcode tools: stop installation with `xcode-select --install` guidance.
- Compiler failure: preserve compiler diagnostics, clean collision-safe temporary files, and leave any prior valid final program untouched.
- Missing runtime program: reject with the resolved path and suggest rerunning `npm install`.
- Spawn failure: reject once with platform-specific context; do not crash through an unhandled `error` event.
- Environment override points to a missing file: report the overridden path; do not silently fall back to a different binary.

## Testing

Tests will use Node's built-in `node:test` runner, avoiding new test-framework dependencies.

Resolver tests will cover:

- Existing Windows x64 paths remain unchanged.
- Apple Silicon selects `darwin-arm64` programs without `.exe`.
- Intel Mac selects `darwin-x64` programs without `.exe`.
- Each environment override wins independently.
- Unsupported platform/architecture combinations return a clear diagnostic.

Installer tests will cover its pure planning, source discovery, fingerprint, cache, override, and validation logic without requiring a Mac compiler on Windows. Runtime wrapper tests will exercise `runDdsProcess` through small temporary executable fixtures where supported and controlled spawn implementations for otherwise untriggerable event orderings. Assertions remain against the public Promise result and single-settlement behavior rather than mock call counts.

`package.json` will expose `npm test` using Node's built-in test runner and `npm run test:dds:smoke` for real DDS protocol checks. Verification commands are:

- `npm test` for the resolver, installer, process runner, and existing JavaScript tests.
- `node --check dds-wrapper.js` and `node --check scripts/install-dds.js`.
- `npm run test:dds:smoke`, which invokes the resolved native programs with known valid full-table and per-position inputs and checks the parsed result shape.
- A bounded `npm start` smoke test after installation.

Release acceptance requires fresh-checkout `npm install`, `npm test`, `npm run test:dds:smoke`, and server startup to pass on both a real Apple Silicon macOS runner and a real Intel macOS runner. The implementation plan will add a project-level macOS CI matrix when suitable runners are available in the repository's CI account; otherwise the same commands must be recorded from both physical/virtual machines before the change is called fully verified. Windows CI or local simulation alone is explicitly insufficient. This Windows workspace can implement and regression-test the platform logic, but cannot claim that native Mac execution passed until those acceptance runs exist.

## Compatibility and Maintenance

The output directory contains the OS and architecture so Intel and Apple Silicon artifacts cannot overwrite one another. The installer derives its production source list from the DDS source tree rather than maintaining a duplicate hand-written list, while excluding tests and non-production directories by construction. The runtime resolver remains small and has no dependency on compiler details, so build layout changes stay isolated from bridge gameplay code.
