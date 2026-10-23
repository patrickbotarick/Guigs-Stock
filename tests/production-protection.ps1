#requires -Version 7.0
# Ferramentas artificiais: este teste não executa PostgreSQL/SQL nem abre rede.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:checks = 0
function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:checks++
}
$repo = Split-Path $PSScriptRoot -Parent
$backupScript = Join-Path $repo 'scripts/backup-production.ps1'
$tokens = $null; $parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($backupScript,[ref]$tokens,[ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'Sintaxe do script de backup inválida'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('guigs-protection-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$backupRoot = Join-Path $testRoot 'Backups privados com espaços'
$null = New-Item -ItemType Directory -Path $backupRoot
$settings = @{HostName='example.invalid';ExpectedHost='example.invalid';DatabaseName='postgres';UserName='test_admin';BackupRoot=$backupRoot}
function Assert-Rejected([hashtable]$Arguments) {
    $rejected = $false
    try { & $backupScript @Arguments | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Operação insegura não foi recusada'
}
$plan = & $backupScript @settings
Assert-True ($plan -like 'SIMULAÇÃO LOCAL*') 'Padrão deve ser simulação'
Assert-True (@(Get-ChildItem -LiteralPath $backupRoot).Count -eq 0) 'Simulação criou arquivos'
$bad = $settings.Clone(); $bad.ExpectedHost='other.invalid'; Assert-Rejected $bad
$bad = $settings.Clone(); $bad.BackupRoot=$repo; Assert-Rejected $bad
$bad = $settings.Clone(); $bad.BackupRoot='relative'; Assert-Rejected $bad
$bad = $settings.Clone(); $bad.HostName='not-a-host/connection'; Assert-Rejected $bad
$nestedGit = Join-Path $testRoot 'OtherRepository'
$null = New-Item -ItemType Directory -Path $nestedGit
'gitdir: fixture' | Set-Content -LiteralPath (Join-Path $nestedGit '.git')
$bad = $settings.Clone(); $bad.BackupRoot=$nestedGit; Assert-Rejected $bad
$junction = Join-Path $testRoot 'LinkedDestination'
$null = New-Item -ItemType Junction -Path $junction -Target $backupRoot
$bad = $settings.Clone(); $bad.BackupRoot=$junction; Assert-Rejected $bad
$bad = $settings.Clone(); $bad.Execute=$true; Assert-Rejected $bad
$bad.Acknowledgement='EXPORTAR_APENAS_LEITURA'; $bad.PasswordFile=''; Assert-Rejected $bad
$bad.PasswordFile=Join-Path $repo 'config.example.js'; Assert-Rejected $bad
$fakePasswordFile = Join-Path $testRoot 'pgpass.conf'
'# Fixture artificial: nenhuma senha real.' | Set-Content -LiteralPath $fakePasswordFile
$bad.PasswordFile=$fakePasswordFile; $bad.PgDumpPath=Join-Path $testRoot 'missing.exe'; Assert-Rejected $bad
Assert-True (@(Get-ChildItem -LiteralPath $backupRoot).Count -eq 0) 'Pré-condições falhas criaram pasta'

# Compila apenas um stub .NET local para simular pg_dump e pg_restore.
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Compilador .NET local indisponível: testes de execução não foram concluídos.' }
$source = Join-Path $testRoot 'FakeTool.cs'
$tool = Join-Path $testRoot 'FakeTool.exe'
@'
using System;
using System.IO;
public static class FakeTool {
  public static int Main(string[] args) {
    if (Environment.GetEnvironmentVariable("GUIGS_TEST_TOOL_FAIL")=="1") {
      Console.Error.WriteLine("SENTINEL_DO_NOT_PRINT"); return 7;
    }
    if (Environment.GetEnvironmentVariable("PGHOSTADDR")!=null || Environment.GetEnvironmentVariable("PGSERVICE")!=null) return 8;
    if (Environment.GetEnvironmentVariable("PGSSLMODE")!="verify-full") return 9;
    if (!(Environment.GetEnvironmentVariable("PGOPTIONS") ?? "").Contains("default_transaction_read_only=on")) return 10;
    if (Environment.GetEnvironmentVariable("PGHOST")!="example.invalid") return 11;
    if (args.Length==2 && args[0]=="--list") {
      if (Environment.GetEnvironmentVariable("GUIGS_TEST_TOOL_FAIL")=="restore") return 15;
      return File.ReadAllText(args[1])=="ARTIFICIAL_ARCHIVE" ? 0 : 12;
    }
    if (Array.IndexOf(args,"--schema=public")<0 || Array.IndexOf(args,"--schema=guigs_private")<0 || Array.IndexOf(args,"--no-password")<0) return 13;
    foreach (var arg in args) if (arg.StartsWith("--file=")) { File.WriteAllText(arg.Substring(7),"ARTIFICIAL_ARCHIVE"); return 0; }
    return 14;
  }
}
'@ | Set-Content -LiteralPath $source
& $compiler /nologo /target:exe "/out:$tool" $source
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível compilar stub local.' }
$execute = $settings.Clone()
$execute.Execute=$true; $execute.Acknowledgement='EXPORTAR_APENAS_LEITURA'
$execute.PasswordFile=$fakePasswordFile; $execute.PgDumpPath=$tool; $execute.PgRestorePath=$tool
$savedHostAddr=$env:PGHOSTADDR; $savedService=$env:PGSERVICE; $savedFailure=$env:GUIGS_TEST_TOOL_FAIL
try {
    $env:PGHOSTADDR='192.0.2.1'; $env:PGSERVICE='fixture-service'; $env:GUIGS_TEST_TOOL_FAIL='0'
    & $backupScript @execute | Out-Null
    $folders = @(Get-ChildItem -LiteralPath $backupRoot -Directory)
    Assert-True ($folders.Count -eq 1) 'Backup fictício não criado'
    $archive=Join-Path $folders[0].FullName 'application.dump'
    $manifest=Get-Content -LiteralPath (Join-Path $folders[0].FullName 'manifest.json') -Raw | ConvertFrom-Json
    Assert-True ($manifest.sha256 -eq (Get-FileHash -LiteralPath $archive).Hash) 'Hash inválido'
    Assert-True ($manifest.scope -like '*excludes Auth*') 'Escopo parcial não declarado'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $folders[0].FullName 'application.partial'))) 'Parcial não finalizado'
    & $backupScript @execute | Out-Null
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Directory).Count -eq 2) 'Backup anterior sobrescrito'
    Assert-True ($env:PGHOSTADDR -eq '192.0.2.1' -and $env:PGSERVICE -eq 'fixture-service') 'Ambiente do operador foi alterado'
    $env:GUIGS_TEST_TOOL_FAIL='1'
    $message=''
    try { & $backupScript @execute | Out-Null } catch { $message=$_.Exception.Message }
    Assert-True ($message -like 'Backup incompleto*' -and $message -notlike '*SENTINEL*') 'Falha expôs saída ou não abortou'
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Recurse -Filter manifest.json).Count -eq 2) 'Falha gerou manifesto de sucesso'
    $env:GUIGS_TEST_TOOL_FAIL='restore'
    Assert-Rejected $execute
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Recurse -Filter application.partial).Count -eq 1) 'Falha de validação não preservou parcial'
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Recurse -Filter manifest.json).Count -eq 2) 'Falha de validação gerou sucesso'
} finally {
    $env:PGHOSTADDR=$savedHostAddr; $env:PGSERVICE=$savedService; $env:GUIGS_TEST_TOOL_FAIL=$savedFailure
}
# Fixtures ficam no TEMP; nenhum backup de produção, credencial real ou arquivo Git alterado.
Write-Output "Proteção: $script:checks verificações passaram; utilitários artificiais, sem rede/SQL."
