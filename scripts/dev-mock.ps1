# Starts VectaSim in development mode with the mock provider (no simulator needed).
#   powershell -File scripts\dev-mock.ps1            # default demo: approach into EDDF 25C, starting in the air on the downwind
#   powershell -File scripts\dev-mock.ps1 goaround   # variants: circuit | bounce | goaround | teleport | reconnect
#   powershell -File scripts\dev-mock.ps1 -Sim       # real simulator instead of the mock
# circuit = full circuit from the stand (start-up, taxi, take-off); see crates/vectasim-core/src/mock.rs
param(
  [string]$Variant = "",
  [switch]$Sim
)
$ErrorActionPreference = "Stop"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargo) { $env:PATH = "$cargo;$env:PATH" }
if ($Sim) {
  Remove-Item Env:VECTASIM_PROVIDER, Env:VECTASIM_MOCK -ErrorAction SilentlyContinue
} else {
  $env:VECTASIM_PROVIDER = "mock"
  if ($Variant) { $env:VECTASIM_MOCK = $Variant } else { Remove-Item Env:VECTASIM_MOCK -ErrorAction SilentlyContinue }
}
Set-Location (Join-Path $PSScriptRoot "..\app")
npm run tauri dev
