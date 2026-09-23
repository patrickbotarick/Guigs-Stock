@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Abrir Guigs Stock.ps1"
if errorlevel 1 pause
