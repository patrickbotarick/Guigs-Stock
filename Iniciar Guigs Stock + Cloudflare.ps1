# Guig's Stock 1.2C.1 - iniciador local + Cloudflare (revisado para diagnostico)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$server = $null
$tunnel = $null
$logDir = Join-Path $env:TEMP 'GuigsStockPreview'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverOut = Join-Path $logDir 'python-out.log'
$serverErr = Join-Path $logDir 'python-err.log'
$cfOut = Join-Path $logDir 'cloudflared-out.log'
$cfErr = Join-Path $logDir 'cloudflared-err.log'
$linkFile = Join-Path $PSScriptRoot 'LINK-CLOUDFLARE-ATUAL.txt'
Remove-Item -LiteralPath $linkFile -ErrorAction SilentlyContinue

function Show-LogIfAny([string]$path) {
    if (Test-Path -LiteralPath $path) {
        $txt = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($txt)) { Write-Host $txt -ForegroundColor DarkYellow }
    }
}

try {
    Write-Host ""
    Write-Host "GUIG'S STOCK | 1.2C.1 - SERVIDOR LOCAL + CLOUDFLARE" -ForegroundColor Yellow
    Write-Host "Teste de desenvolvimento. O link Cloudflare e publico." -ForegroundColor Yellow

    do {
        $typed = Read-Host 'Qual porta deseja utilizar? [Enter = 8080]'
        if ([string]::IsNullOrWhiteSpace($typed)) { $typed = '8080' }
        $port = 0
        $valid = [int]::TryParse($typed, [ref]$port) -and $port -ge 1024 -and $port -le 65535
        if (-not $valid) {
            Write-Host 'Escolha uma porta entre 1024 e 65535.' -ForegroundColor Red
            continue
        }

        Write-Host "Verificando a porta $port..." -ForegroundColor DarkGray
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        try {
            $listener.Start()
            $free = $true
        } catch {
            $free = $false
            Write-Host "A porta $port ja esta ocupada. Escolha outra." -ForegroundColor Red
        } finally {
            try { $listener.Stop() } catch {}
        }
    } until ($valid -and $free)

    Write-Host "Porta selecionada: $port" -ForegroundColor Green

    # Detecta uma instalacao real do Python.
    $pythonExe = $null
    $pythonArgsPrefix = @()
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
    if ($py) {
        try {
            & $py.Source -3 -c "import sys; print(sys.executable)" *> $null
            if ($LASTEXITCODE -eq 0) {
                $pythonExe = $py.Source
                $pythonArgsPrefix = @('-3')
            }
        } catch {}
    }
    if (-not $pythonExe) {
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
        if ($python) {
            try {
                & $python.Source -c "import sys; print(sys.version)" *> $null
                if ($LASTEXITCODE -eq 0) { $pythonExe = $python.Source }
            } catch {}
        }
    }
    if (-not $pythonExe) {
        throw 'Python 3 nao foi localizado no PATH. Teste no CMD: py -3 --version ou python --version.'
    }

    Write-Host "Python encontrado: $pythonExe" -ForegroundColor Green
    Remove-Item -LiteralPath $serverOut,$serverErr -ErrorAction SilentlyContinue
    $serverArgs = $pythonArgsPrefix + @('-m','http.server',"$port",'--bind','127.0.0.1')
    Write-Host "Iniciando servidor local em http://127.0.0.1:$port ..." -ForegroundColor Cyan
    $server = Start-Process -FilePath $pythonExe -ArgumentList $serverArgs -PassThru -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    $local = "http://127.0.0.1:$port/"
    $ready = $false
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        if ($server.HasExited) { break }
        try {
            $response = Invoke-WebRequest -Uri $local -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        if (($i % 5) -eq 4) { Write-Host 'Ainda aguardando o servidor...' -ForegroundColor DarkGray }
    }
    if (-not $ready) {
        Write-Host 'Saida do Python:' -ForegroundColor Yellow
        Show-LogIfAny $serverOut
        Show-LogIfAny $serverErr
        throw "O servidor nao respondeu em $local. Logs: $logDir"
    }

    Write-Host "Servidor local OK: $local" -ForegroundColor Green

    $browserPaths = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $browser = $browserPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($browser) {
        Write-Host 'Abrindo o aplicativo em janela propria...' -ForegroundColor Cyan
        Start-Process -FilePath $browser -ArgumentList @("--app=$local", '--window-size=1280,850') | Out-Null
    } else {
        Start-Process $local | Out-Null
    }

    $cloud = Join-Path $PSScriptRoot 'cloudflared.exe'
    if (-not (Test-Path -LiteralPath $cloud)) {
        $cloudCmd = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
        if (-not $cloudCmd) { $cloudCmd = Get-Command cloudflared -ErrorAction SilentlyContinue }
        if ($cloudCmd) { $cloud = $cloudCmd.Source }
    }

    if (-not (Test-Path -LiteralPath $cloud)) {
        Write-Host ''
        Write-Host 'cloudflared nao foi localizado. O aplicativo LOCAL esta funcionando.' -ForegroundColor Yellow
        Write-Host 'Teste no CMD: cloudflared --version'
        Write-Host "Endereco local: $local"
        Write-Host "Logs: $logDir"
        Read-Host 'Pressione Enter para encerrar o servidor local' | Out-Null
        return
    }

    Write-Host "Cloudflared encontrado: $cloud" -ForegroundColor Green
    Remove-Item -LiteralPath $cfOut,$cfErr -ErrorAction SilentlyContinue
    Write-Host 'Criando Quick Tunnel Cloudflare...' -ForegroundColor Cyan
    $tunnel = Start-Process -FilePath $cloud -ArgumentList @('tunnel','--no-autoupdate','--url',"http://127.0.0.1:$port") -PassThru -WindowStyle Hidden -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr

    $public = $null
    for ($i=0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        $logs = ''
        if (Test-Path -LiteralPath $cfOut) { $logs += (Get-Content -LiteralPath $cfOut -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $cfErr) { $logs += "`n" + (Get-Content -LiteralPath $cfErr -Raw -ErrorAction SilentlyContinue) }
        $match = [regex]::Match($logs, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
        if ($match.Success) { $public = $match.Value; break }
        if ($tunnel.HasExited) { break }
        if (($i % 20) -eq 19) { Write-Host 'Aguardando o link do Cloudflare...' -ForegroundColor DarkGray }
    }

    if (-not $public) {
        Write-Host 'O servidor local esta OK, mas o Cloudflare nao retornou um link.' -ForegroundColor Red
        Show-LogIfAny $cfOut
        Show-LogIfAny $cfErr
        Write-Host "Logs: $logDir"
    } else {
        Set-Content -LiteralPath $linkFile -Value $public -Encoding UTF8
        Write-Host ''
        Write-Host '==================================================' -ForegroundColor Green
        Write-Host 'LINK CLOUDFLARE PARA TESTE NO CELULAR:' -ForegroundColor Green
        Write-Host $public -ForegroundColor Cyan
        Write-Host '==================================================' -ForegroundColor Green
        try { Set-Clipboard -Value $public; Write-Host 'Link copiado para a area de transferencia.' } catch {}
        Write-Host "Link salvo em: $linkFile"
    }

    Write-Host ''
    Write-Host 'Mantenha esta janela aberta durante o teste.' -ForegroundColor Yellow
    Read-Host 'Pressione Enter para encerrar servidor e tunel' | Out-Null
}
catch {
    Write-Host ''
    Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Logs de diagnostico: $logDir" -ForegroundColor Yellow
    Read-Host 'Pressione Enter para sair' | Out-Null
    exit 1
}
finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    Write-Host 'Servidor e tunel encerrados.' -ForegroundColor DarkGray
}
