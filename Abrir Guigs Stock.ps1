# Guig's Stock 1.2
# Iniciador local sem Cloudflare

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$port = 8082
$localUrl = "http://127.0.0.1:$port/"
$server = $null


function Test-GuigsServer {

    try {

        $response = Invoke-WebRequest `
            -Uri $localUrl `
            -UseBasicParsing `
            -TimeoutSec 2

        if ($response.StatusCode -eq 200) {
            return $true
        }

    }
    catch {
        return $false
    }

    return $false
}


function Find-Python {

    $py = Get-Command py.exe -ErrorAction SilentlyContinue

    if (-not $py) {
        $py = Get-Command py -ErrorAction SilentlyContinue
    }

    if ($py) {

        try {

            & $py.Source -3 -c "import sys" *> $null

            if ($LASTEXITCODE -eq 0) {

                return @{
                    Exe = $py.Source
                    Args = @("-3")
                }
            }

        }
        catch {
        }
    }


    $python = Get-Command python.exe -ErrorAction SilentlyContinue

    if (-not $python) {
        $python = Get-Command python -ErrorAction SilentlyContinue
    }

    if ($python) {

        try {

            & $python.Source -c "import sys" *> $null

            if ($LASTEXITCODE -eq 0) {

                return @{
                    Exe = $python.Source
                    Args = @()
                }
            }

        }
        catch {
        }
    }


    return $null
}


function Find-Browser {

    $paths = @(

        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",

        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",

        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",

        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",

        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",

        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )


    foreach ($path in $paths) {

        if (Test-Path -LiteralPath $path) {
            return $path
        }
    }


    return $null
}


try {

    Write-Host ""
    Write-Host "GUIG'S STOCK 1.2" -ForegroundColor Yellow
    Write-Host "Iniciando servidor local..." -ForegroundColor Cyan
    Write-Host ""


    # Se já existir um servidor respondendo na porta 8082,
    # não inicia outro.

    $serverReady = Test-GuigsServer


    if (-not $serverReady) {

        # Verifica se a porta está livre.

        $listener = New-Object System.Net.Sockets.TcpListener(
            [System.Net.IPAddress]::Loopback,
            $port
        )

        $portFree = $false

        try {

            $listener.Start()
            $portFree = $true

        }
        catch {

            $portFree = $false

        }
        finally {

            try {
                $listener.Stop()
            }
            catch {
            }
        }


        if (-not $portFree) {

            throw "A porta $port esta ocupada por outro programa."
        }


        # Localiza Python.

        $python = Find-Python


        if (-not $python) {

            throw "Python 3 nao foi encontrado. Teste no terminal: py -3 --version"
        }


        Write-Host "Python encontrado: $($python.Exe)" -ForegroundColor Green


        # Monta os argumentos.

        $arguments = @()

        foreach ($arg in $python.Args) {
            $arguments += $arg
        }

        $arguments += "-m"
        $arguments += "http.server"
        $arguments += "$port"
        $arguments += "--bind"
        $arguments += "127.0.0.1"


        # Inicia servidor HTTP.

        $server = Start-Process `
            -FilePath $python.Exe `
            -ArgumentList $arguments `
            -WorkingDirectory $PSScriptRoot `
            -WindowStyle Hidden `
            -PassThru


        # Aguarda o servidor responder.

        $serverReady = $false

        for ($i = 0; $i -lt 30; $i++) {

            Start-Sleep -Milliseconds 300

            if (Test-GuigsServer) {

                $serverReady = $true
                break
            }


            if ($server -ne $null) {

                if ($server.HasExited) {
                    break
                }
            }
        }


        if (-not $serverReady) {

            throw "O servidor local nao respondeu em $localUrl"
        }
    }


    Write-Host "Servidor local OK." -ForegroundColor Green
    Write-Host $localUrl -ForegroundColor Green
    Write-Host ""


    # Localiza Edge ou Chrome.

    $browser = Find-Browser


    if ($browser) {

        Write-Host "Abrindo Guig's Stock..." -ForegroundColor Cyan

        Start-Process `
            -FilePath $browser `
            -ArgumentList "--app=$localUrl", "--window-size=1280,850"

    }
    else {

        Write-Host "Edge/Chrome nao encontrado. Abrindo navegador padrao..." -ForegroundColor Yellow

        Start-Process $localUrl
    }


    Write-Host ""
    Write-Host "Guig's Stock iniciado com sucesso." -ForegroundColor Green

}
catch {

    Write-Host ""
    Write-Host "ERRO AO INICIAR O GUIG'S STOCK" -ForegroundColor Red
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""

    exit 1
}