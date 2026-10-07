param(
  [string]$ProjectRoot,
  [string]$BuildRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Join-Path $PSScriptRoot '..'
}
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)

if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
  $BuildRoot = Join-Path $ProjectRoot 'dds\Build'
}
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)

$ddsRoot = Join-Path $ProjectRoot 'dds'
$projectPath = Join-Path $ddsRoot 'solution\DDS.vcxproj'
$includePath = Join-Path $ddsRoot 'library\src'
$cliRoot = Join-Path $ProjectRoot 'native\dds-cli'
$outputPath = Join-Path $BuildRoot 'bin\x64\Release'
$objectPath = Join-Path $BuildRoot 'int\x64\Release\StepstoneCli'
$libraryPath = Join-Path $outputPath 'DDS.lib'
$programs = @(
  @{
    Name = 'dds_calc'
    Source = (Join-Path $ProjectRoot 'native\dds-cli\dds_calc.cpp')
    Executable = (Join-Path $outputPath 'dds_calc.exe')
    Object = (Join-Path $objectPath 'dds_calc.obj')
  },
  @{
    Name = 'dds_solve'
    Source = (Join-Path $ProjectRoot 'native\dds-cli\dds_solve.cpp')
    Executable = (Join-Path $outputPath 'dds_solve.exe')
    Object = (Join-Path $objectPath 'dds_solve.obj')
  }
)

foreach ($requiredPath in @($projectPath, $includePath, $cliRoot)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required DDS build input is missing: $requiredPath"
  }
}

$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswherePath = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
  throw "Visual Studio locator is missing: $vswherePath"
}

$installationJson = & $vswherePath -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json
if ($LASTEXITCODE -ne 0) {
  throw "vswhere.exe failed with exit code $LASTEXITCODE"
}
$installations = @($installationJson | ConvertFrom-Json)
if ($installations.Count -ne 1) {
  throw "Expected exactly one Visual Studio installation with the x64 C++ toolchain; found $($installations.Count)"
}

$installationPath = [string]$installations[0].installationPath
$installationVersion = [Version]([string]$installations[0].installationVersion)
$platformToolset = switch ($installationVersion.Major) {
  16 { 'v142' }
  17 { 'v143' }
  18 { 'v145' }
  default { throw "Unsupported Visual Studio major version: $($installationVersion.Major)" }
}

$devShellModule = Join-Path $installationPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
if (-not (Test-Path -LiteralPath $devShellModule -PathType Leaf)) {
  throw "Visual Studio developer shell module is missing: $devShellModule"
}
Import-Module $devShellModule
Enter-VsDevShell -VsInstallPath $installationPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

New-Item -ItemType Directory -Force $outputPath | Out-Null
New-Item -ItemType Directory -Force $objectPath | Out-Null

Push-Location $ProjectRoot
try {
  Invoke-Checked -Command 'msbuild.exe' -Description 'DDS static library build' -Arguments @(
    $projectPath,
    '/m',
    '/nologo',
    '/verbosity:minimal',
    '/p:Configuration=Release',
    '/p:Platform=x64',
    "/p:PlatformToolset=$platformToolset",
    "/p:BuildDir=$BuildRoot\"
  )

  if (-not (Test-Path -LiteralPath $libraryPath -PathType Leaf)) {
    throw "DDS static library was not produced: $libraryPath"
  }

  foreach ($program in $programs) {
    $programName = [string]$program.Name
    $sourcePath = [string]$program.Source
    $executablePath = [string]$program.Executable
    $programObjectPath = [string]$program.Object
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "DDS CLI source is missing: $sourcePath"
    }

    Invoke-Checked -Command 'cl.exe' -Description "$programName build" -Arguments @(
      '/nologo',
      '/O2',
      '/MD',
      '/std:c++20',
      '/EHsc',
      '/utf-8',
      "/I$includePath",
      "/Fo$programObjectPath",
      "/Fe$executablePath",
      $sourcePath,
      $libraryPath
    )

    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
      throw "DDS CLI executable was not produced: $executablePath"
    }
  }
} finally {
  Pop-Location
}

Write-Host "DDS Windows baselines are ready in $outputPath"
