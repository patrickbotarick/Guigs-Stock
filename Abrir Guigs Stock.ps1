# Inicia o arquivo local em uma janela independente do Edge/Chrome, sem guia comum.
$ErrorActionPreference = 'Stop'
$index = Join-Path $PSScriptRoot 'index.html'
if (-not (Test-Path -LiteralPath $index)) { Write-Host 'index.html nao encontrado. Extraia a pasta inteira.'; exit 1 }
$url = ([System.Uri]::new((Resolve-Path -LiteralPath $index).Path)).AbsoluteUri
$paths = @(
 "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
 "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
 "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
 "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
 "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
 "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { Write-Host 'Microsoft Edge ou Google Chrome nao encontrado. Abra index.html manualmente.'; exit 1 }
Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--window-size=1280,850')
