@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo Iniciando Guig's Stock...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Iniciar Guigs Stock + Cloudflare.ps1"
if errorlevel 1 (
  echo.
  echo O iniciador terminou com erro.
  pause
)
