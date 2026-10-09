# DDS Official Version and Local Build Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the `dds` submodule at the parent repository's official pinned commit while producing local DDS executables through Stepstone-owned build adapters.

**Architecture:** The submodule remains upstream-owned and contains no Stepstone-specific wrapper commits. Stepstone keeps its CLI adapters and build scripts in `native/dds-cli/` and `scripts/`; generated executables remain ignored build outputs. The parent repository records the official submodule pointer and tests verify the build contract.

**Tech Stack:** Git submodules, Node.js test runner, PowerShell, Visual Studio C++ toolchain, official DDS C++ sources.

---

### Task 1: Record the current state and align the submodule

**Files:**
- Modify: `dds` (submodule checkout only)

- [ ] Save the current submodule commit and confirm the parent-recorded commit before changing anything.
- [ ] Check out the parent-recorded official DDS commit in the submodule.
- [ ] Verify the submodule worktree is clean and the parent reports only the intentional submodule pointer change.

### Task 2: Verify the Stepstone-owned build boundary

**Files:**
- Verify: `native/dds-cli/dds_calc.cpp`
- Verify: `native/dds-cli/dds_solve.cpp`
- Verify: `scripts/build-windows-dds.ps1`
- Verify: `.gitignore`
- Verify: `test/dds-build.test.js`

- [ ] Confirm the adapters compile against official DDS headers and do not depend on files added inside the submodule fork.
- [ ] Confirm `.exe`, `.lib`, and `.obj` outputs are ignored and are not staged as source changes.
- [ ] Run the focused DDS build-contract tests.

### Task 3: Build and regression verification

**Files:**
- No source changes expected unless a verification failure identifies a real contract defect.

- [ ] Run the Windows DDS build script when the local Visual Studio toolchain is available.
- [ ] Run `npm test` and `npm run test:workers`.
- [ ] Inspect Git status and report the exact resulting submodule pointer and generated artifact paths.

