param(
  [Parameter(Mandatory = $true)] [string] $WorkDirectory
)

$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $target) { throw "Build directory must not exist: $target" }
New-Item -ItemType Directory -Path $target | Out-Null

$emsdk = Join-Path $target 'emsdk'
$source = Join-Path $target 'bridge-dds-js'
git clone https://github.com/emscripten-core/emsdk.git $emsdk
if ($LASTEXITCODE -ne 0) { throw 'emsdk clone failed' }
git -C $emsdk checkout 3d6d8ee910466516a53e665b86458faa81dae9ba
if ($LASTEXITCODE -ne 0) { throw 'emsdk checkout failed' }
& (Join-Path $emsdk 'emsdk.ps1') install 3.1.74
if ($LASTEXITCODE -ne 0) { throw 'Emscripten install failed' }
& (Join-Path $emsdk 'emsdk.ps1') activate 3.1.74
if ($LASTEXITCODE -ne 0) { throw 'Emscripten activation failed' }
& (Join-Path $emsdk 'emsdk_env.ps1')
$releaseTags = Get-Content -LiteralPath (Join-Path $emsdk 'emscripten-releases-tags.json') -Raw | ConvertFrom-Json
$release = $releaseTags.releases.'3.1.74'
if ($release -ne 'c2655005234810c7c42e02a18e4696554abe0352') { throw "Unexpected Emscripten release: $release" }

git clone https://github.com/bookchris/bridge-dds-js.git $source
if ($LASTEXITCODE -ne 0) { throw 'bridge-dds clone failed' }
git -C $source checkout 23c72429f5cb382d0f8805ea1ac44658c1116006
if ($LASTEXITCODE -ne 0) { throw 'bridge-dds checkout failed' }
git -C $source submodule update --init
if ($LASTEXITCODE -ne 0) { throw 'DDS submodule checkout failed' }
$ddsRevision = (git -C (Join-Path $source 'dds') rev-parse HEAD).Trim()
if ($ddsRevision -ne '8fdbe384fb4ee3eb837aa726578e1730494251fe') { throw "Unexpected DDS revision: $ddsRevision" }

$sources = @(
  'dds.cpp','dump.cpp','ABsearch.cpp','ABstats.cpp','CalcTables.cpp',
  'DealerPar.cpp','File.cpp','Init.cpp','LaterTricks.cpp','Memory.cpp',
  'Moves.cpp','Par.cpp','PlayAnalyser.cpp','PBN.cpp','QuickTricks.cpp',
  'Scheduler.cpp','SolveBoard.cpp','SolverIF.cpp','System.cpp',
  'ThreadMgr.cpp','Timer.cpp','TimerGroup.cpp','TimerList.cpp',
  'TimeStat.cpp','TimeStatList.cpp','TransTableS.cpp','TransTableL.cpp'
) | ForEach-Object { "dds/src/$_" }
$output = Join-Path $target 'dds-worker-static.js'
Push-Location $source
try {
& (Join-Path $emsdk 'upstream/emscripten/em++.bat') `
  -D__WASM__ -O3 -std=c++11 @sources -o $output `
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_SetMaxThreads","_AnalysePlayPBN","_CalcDDtablePBN","_SolveBoardPBN","_DealerPar"]' `
  '-sEXPORTED_RUNTIME_METHODS=["cwrap","ccall","getValue","setValue","stringToUTF8","UTF8ToString","HEAPU8"]' `
  -sMODULARIZE=1 -sSINGLE_FILE=1 -sEXPORT_ES6=1 -sNO_EXIT_RUNTIME=1 `
  -sALLOW_MEMORY_GROWTH=1 -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1 `
  -sENVIRONMENT=worker -sMINIMAL_RUNTIME=1 -sEXPORT_KEEPALIVE=1 -sFILESYSTEM=0
if ($LASTEXITCODE -ne 0) { throw 'DDS compilation failed' }
} finally { Pop-Location }
$unpatchedHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
if ($unpatchedHash -ne 'ec0a2b8bc5713996907d9afd8e8863b26ecee677f18b482ecd723922084db27c') {
  throw "Unpatched artifact hash mismatch: $unpatchedHash"
}
# Emscripten 3.1.74's minimal runtime logs an instantiate error but leaves its
# ready promise pending. Settle that promise with the same error instead.
$oldHandler = 'error=>{console.error(error)}'
$newHandler = 'error=>{readyPromiseReject(error)}'
$generated = [System.IO.File]::ReadAllText($output)
if ($generated.Split(@($oldHandler), [System.StringSplitOptions]::None).Length -ne 2) {
  throw 'Expected one Emscripten instantiate failure handler'
}
[System.IO.File]::WriteAllText(
  $output, $generated.Replace($oldHandler, $newHandler),
  [System.Text.UTF8Encoding]::new($false)
)
$actual = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
$expected = '875c4ed0ab297192e92dfbb19ee25c889f77eacafa8c490504958f69492519af'
if ($actual -ne $expected) { throw "Artifact hash mismatch: $actual" }

# Workers cannot compile Wasm from bytes at runtime. Keep the exact pinned
# single-file output above as provenance, then emit its Wasm as a static module
# and let the generated glue accept a precompiled WebAssembly.Module.
$pinned = [System.IO.File]::ReadAllText($output)
$embedded = [regex]::Match($pinned, 'Module\["wasm"\]=base64Decode\("(?<bytes>[A-Za-z0-9+/=]+)"\)')
if (-not $embedded.Success) { throw 'Expected one embedded DDS Wasm module' }
$wasmPath = Join-Path $target 'dds-worker.wasm'
[System.IO.File]::WriteAllBytes($wasmPath, [Convert]::FromBase64String($embedded.Groups['bytes'].Value))
$wasmHash = (Get-FileHash -LiteralPath $wasmPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($wasmHash -ne 'ddc660d975c5abd08ec8490a9456dd68d202579c540e9353078b6bdecaddf5f7') {
  throw "Wasm hash mismatch: $wasmHash"
}

$wasmInitializer = 'Module["wasm"]=base64Decode('
$wasmInitializerWorker = 'Module["wasm"]=Module["wasm"]||base64Decode('
$instanceAccess = 'output.instance.exports'
$instanceAccessWorker = '(output.instance??output).exports'
foreach ($part in @($wasmInitializer, $instanceAccess)) {
  if ($pinned.Split(@($part), [System.StringSplitOptions]::None).Length -ne 2) {
    throw "Expected one generated glue occurrence: $part"
  }
}
$workerOutput = Join-Path $target 'dds-worker.mjs'
$workerGlue = $pinned.Replace($wasmInitializer, $wasmInitializerWorker).Replace($instanceAccess, $instanceAccessWorker)
[System.IO.File]::WriteAllText($workerOutput, $workerGlue, [System.Text.UTF8Encoding]::new($false))
$workerHash = (Get-FileHash -LiteralPath $workerOutput -Algorithm SHA256).Hash.ToLowerInvariant()
if ($workerHash -ne 'da11523782524ae2b4274e1123794f0a50e47403924dbb90b0ddde9bb723ac1d') {
  throw "Worker glue hash mismatch: $workerHash"
}
Write-Output "Reproduced $output SHA256 $actual"
Write-Output "Reproduced $wasmPath SHA256 $wasmHash"
Write-Output "Reproduced $workerOutput SHA256 $workerHash"
