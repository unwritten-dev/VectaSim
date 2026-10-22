# Resource usage of a running VectaSim: the app process plus every WebView2 process it owns
# (msedgewebview2.exe children, grandchildren …), sampled over -Seconds.
#
#   powershell -NoProfile -File scripts\measure-resources.ps1 -Label "idle" -Seconds 30
#
# Prints one line: label, process count, private memory (MB), working set (MB), average CPU (% of
# one core and % of the machine). GPU load is not measured (no reliable per-process counter on a
# headless/RDP box). Run against the release build (target\release\vectasim.exe or the installed
# app) – the dev build is a debug binary with the Vite dev server and is not representative.
param(
  [string]$Label = "sample",
  [int]$Seconds = 30,
  [string]$ProcessName = "vectasim"
)
$ErrorActionPreference = "Stop"

function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($rootPid)
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId); $grew = $true
      }
    }
  }
  return $ids
}

$root = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$ids = Get-Tree $root.Id
$procs = @(Get-Process | Where-Object { $ids.Contains($_.Id) })
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

$cpu0 = ($procs | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum
$t0 = Get-Date
Start-Sleep -Seconds $Seconds
$procs = @(Get-Process | Where-Object { $ids.Contains($_.Id) })
$cpu1 = ($procs | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum
$elapsed = ((Get-Date) - $t0).TotalMilliseconds

$private = ($procs | ForEach-Object { $_.PrivateMemorySize64 } | Measure-Object -Sum).Sum / 1MB
$ws = ($procs | ForEach-Object { $_.WorkingSet64 } | Measure-Object -Sum).Sum / 1MB
$cpuCore = ($cpu1 - $cpu0) / $elapsed * 100
$cpuMachine = $cpuCore / $cores

"{0,-28} procs={1,2}  private={2,6:N0} MB  workingset={3,6:N0} MB  cpu={4,5:N1}% of a core ({5,4:N1}% of {6} cores)" -f $Label, $procs.Count, $private, $ws, $cpuCore, $cpuMachine, $cores
