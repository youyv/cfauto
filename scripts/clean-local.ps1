#Requires -Version 7.0
param([switch]$Apply, [switch]$Build)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a reparse-point workspace root' }
if ((Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).name -ne 'worker-pro-refactor') { throw 'Unexpected project root' }
# Deliberately never select .git, node_modules, .pnpm-store, .wrangler as a whole,
# operator inputs, production archives, journals or current validation evidence.
$relativePaths = @('.wrangler/tmp', 'test/fixtures/reliability/.wrangler/tmp', 'playwright-report', 'test-results', 'test-results-c7-prior', '%SystemDrive%')
if ($Build) { $relativePaths += @('dist', 'src/frontend-bundle.ts') }
$plan = @()
foreach ($relative in $relativePaths) {
    $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (!$target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path escapes workspace' }
    if (!(Test-Path -LiteralPath $target)) { continue }
    $cursor = $root
    foreach ($part in ($relative -split '/')) {
        $cursor = Join-Path $cursor $part
        if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing cleanup through a reparse point' }
    }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (!$resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved cleanup path escapes workspace' }
    $item = Get-Item -LiteralPath $resolved -Force
    $children = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $resolved -Force -Recurse) } else { @($item) }
    if (@($children | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw 'Refusing a cache tree containing reparse points' }
    $files = @($children | Where-Object { !$_.PSIsContainer })
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    $plan += [pscustomobject]@{ path = $resolved; relative = $relative; files = $files.Count; bytes = [long]$bytes; removed = $false; directory = $item.PSIsContainer }
}
# All targets have been resolved and audited before any recursive removal.
if ($Apply) {
    foreach ($entry in $plan) {
        if ($entry.directory) { Remove-Item -LiteralPath $entry.path -Recurse -Force }
        else { Remove-Item -LiteralPath $entry.path -Force }
        if (Test-Path -LiteralPath $entry.path) { throw 'Cleanup target still exists' }
        $entry.removed = $true
    }
}
[ordered]@{ schema = 1; root = $root; applied = [bool]$Apply; includesBuild = [bool]$Build; bytes = [long](($plan | Measure-Object -Property bytes -Sum).Sum); targets = @($plan) } | ConvertTo-Json -Depth 5
