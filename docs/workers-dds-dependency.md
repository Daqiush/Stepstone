# Workers DDS dependency

The Worker bundle uses a vendored, single-file ESM build of double-dummy solver
(DDS). `workers/vendor/bridge-dds/dds-worker.mjs` embeds its Wasm bytes as
base64. It does not load a separate asset at runtime. The generated module is
imported only by `workers/src/dds-wasm-loader.mjs`; no npm dependency or Node
runtime API is involved.

## Exact source and license

- [bridge-dds-js](https://github.com/bookchris/bridge-dds-js/tree/23c72429f5cb382d0f8805ea1ac44658c1116006),
  commit `23c72429f5cb382d0f8805ea1ac44658c1116006`, Apache-2.0.
  The vendored [license](../workers/vendor/bridge-dds/LICENSE.bridge-dds)
  corresponds to the upstream [LICENSE](https://github.com/bookchris/bridge-dds-js/blob/23c72429f5cb382d0f8805ea1ac44658c1116006/LICENSE).
- [DDS](https://github.com/ed2k/dds/tree/8fdbe384fb4ee3eb837aa726578e1730494251fe),
  submodule commit `8fdbe384fb4ee3eb837aa726578e1730494251fe`,
  Apache-2.0. The vendored [license](../workers/vendor/bridge-dds/LICENSE.dds)
  corresponds to the submodule [LICENSE](https://github.com/ed2k/dds/blob/8fdbe384fb4ee3eb837aa726578e1730494251fe/LICENSE).
- [emsdk](https://github.com/emscripten-core/emsdk/tree/3d6d8ee910466516a53e665b86458faa81dae9ba)
  commit `3d6d8ee910466516a53e665b86458faa81dae9ba` installs Emscripten
  `3.1.74`, release commit `c2655005234810c7c42e02a18e4696554abe0352`.

The vendored ESM file is 455,341 bytes with SHA-256
`b436073a6941a8eee13f093b2435906d905d9c8a69080b3e6a8f66d07b252442`.
This is the exact tracked and checkout byte sequence, including CRLF line
endings; `workers/vendor/bridge-dds/.gitattributes` sets `-text` for this
generated file so Git does not convert it on any platform. The loader test
compares the checkout bytes to the Git index and checks this pinned hash.
Its decoded embedded Wasm is 323,370 bytes with SHA-256
`ddc660d975c5abd08ec8490a9456dd68d202579c540e9353078b6bdecaddf5f7`.
An independent repeat build from these commits, followed by the documented
one-substitution post-processing step, produced byte-identical output.

## Rebuild

From the repository root in PowerShell, choose a new, empty work directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workers/vendor/bridge-dds/build.ps1 -WorkDirectory D:\dds-worker-rebuild
```

The [build script](../workers/vendor/bridge-dds/build.ps1) clones and checks out
both pinned sources, installs the pinned toolchain into that work directory,
compiles the upstream `dds/src/Makefiles/sources.txt` source set, patches one
Emscripten-generated error handler, and checks the resulting SHA-256. The
unpatched output has SHA-256
`0ad3615f1be57389e16457ba0514fa04e86d393dc4d5fc7298f7f66f3055f218`.
The only change replaces `error=>{console.error(error)}` with
`error=>{readyPromiseReject(error)}`. Emscripten 3.1.74's generated minimal
runtime otherwise leaves the module's ready promise pending when
`WebAssembly.instantiate` rejects. The embedded Wasm bytes are unchanged. The
script does not activate a global toolchain. Its full compiler flags are:

```text
-D__WASM__ -O3 -std=c++11
-sEXPORTED_FUNCTIONS=["_malloc","_free","_SetMaxThreads","_AnalysePlayPBN","_CalcDDtablePBN","_SolveBoardPBN","_DealerPar"]
-sEXPORTED_RUNTIME_METHODS=["cwrap","ccall","getValue","setValue","stringToUTF8","UTF8ToString"]
-sMODULARIZE=1 -sSINGLE_FILE=1 -sEXPORT_ES6=1 -sNO_EXIT_RUNTIME=1
-sALLOW_MEMORY_GROWTH=1 -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1
-sENVIRONMENT=worker -sMINIMAL_RUNTIME=1 -sEXPORT_KEEPALIVE=1 -sFILESYSTEM=0
```

The artifact is Worker-safe because it contains no dynamic import, Node
`require`, `fetch`, `XMLHttpRequest`, `import.meta`, or
`WebAssembly.instantiateStreaming`. Its sole Wasm instantiation uses decoded
embedded bytes. The loader test imports it in plain Node ESM with network APIs
set to throw; Node is used only as the test host and contributes no runtime
dependency to the generated file.

## Adapter mapping

`loadDdsModule()` memoizes one successful initialization per module instance,
clears a rejected initialization so a later call can retry, and returns exactly
`calcDDTablePbn` and `solveBoardPbn`. The adapter's PBN hand
format has a label for each seat; DDS PBN expects one leading seat label and
four clockwise hands. The loader converts this syntax at the ABI boundary.

`calcDDTablePbn` writes the 80-byte `ddTableDealPBN`, invokes
`CalcDDtablePBN`, and maps `resTable[strain][seat]` to the adapter's
`{ N/E/S/W: { S/H/D/C/NT: tricks } }` object. `solveBoardPbn` writes the
112-byte `dealPBN` with `trump`, first seat, up to three current-trick cards,
and remaining PBN hands. It calls `SolveBoardPBN` with target `-1`, solutions
`2`, and mode `1` for all optimal cards and a computed score, even when only
one card is legal. The returned `futureTricks.score` is for the current
player's partnership and includes the current trick. `equals` rank bits are
expanded into explicit equivalent cards before returning `{ score, cards }`.
Both calls free their Wasm buffers, and non-success DDS codes throw.

Only these two DDS methods are exposed. Dealer par, play analysis, alternate
target/solution modes, multithreaded DDS, and non-PBN APIs are unsupported.
The caller must provide legal, complete bridge positions; the outer adapter
normalizes card shapes but does not prove all game-state invariants.
