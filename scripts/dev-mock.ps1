# Startet VectaSim im Entwicklungsmodus mit dem Mock-Provider (ohne Simulator).
#   powershell -File scripts\dev-mock.ps1            # Standard-Platzrunde
#   powershell -File scripts\dev-mock.ps1 goaround   # Varianten: bounce | goaround | teleport | reconnect
#   powershell -File scripts\dev-mock.ps1 -Sim       # echter Simulator statt Mock
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
