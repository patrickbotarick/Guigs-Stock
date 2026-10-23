#requires -Version 7.0
<# Backup LÓGICO DA APLICAÇÃO; não inclui Auth, Storage, roles globais ou configuração.
   Sem -Execute: apenas valida o plano local, sem abrir conexão ou criar arquivos.
   Nunca restaura, apaga arquivos, envia backups ou executa migrations.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HostName,
    [Parameter(Mandatory)][string]$ExpectedHost,
    [Parameter(Mandatory)][string]$DatabaseName,
    [Parameter(Mandatory)][string]$UserName,
    [Parameter(Mandatory)][string]$BackupRoot,
    [ValidateRange(1,65535)][int]$Port = 5432,
    [string]$PasswordFile = $env:PGPASSFILE,
    [string]$PgDumpPath = 'pg_dump.exe',
    [string]$PgRestorePath = 'pg_restore.exe',
    [switch]$Execute,
    [string]$Acknowledgement
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExternalPath([string]$Candidate, [bool]$Directory) {
    if (-not [IO.Path]::IsPathFullyQualified($Candidate)) { throw 'Use um caminho absoluto externo ao Git.' }
    $item = Get-Item -LiteralPath $Candidate -Force
    if ($Directory -and $item -isnot [IO.DirectoryInfo]) { throw 'A raiz de backup deve ser uma pasta existente.' }
    if (-not $Directory -and $item -is [IO.DirectoryInfo]) { throw 'O arquivo de senha deve ser um arquivo existente.' }
    $cursor = $item
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links e junctions não são aceitos no caminho externo.' }
        if ($cursor -is [IO.DirectoryInfo] -and (Test-Path -LiteralPath (Join-Path $cursor.FullName '.git'))) {
            throw 'Destino ou credencial dentro de um repositório Git: operação recusada.'
        }
        $cursor = if ($cursor -is [IO.DirectoryInfo]) { $cursor.Parent } else { $cursor.Directory }
    }
    return $item.FullName
}

function Invoke-BackupTool([string]$Tool, [string[]]$ToolArguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Tool
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in $ToolArguments) { $info.ArgumentList.Add($arg) }
    # Ignora PGHOSTADDR, PGSERVICE e demais parâmetros herdados que mudariam o alvo.
    foreach ($key in @($info.Environment.Keys)) { if ($key -like 'PG*') { $info.Environment.Remove($key) | Out-Null } }
    $info.Environment['PGHOST'] = $HostName
    $info.Environment['PGPORT'] = [string]$Port
    $info.Environment['PGDATABASE'] = $DatabaseName
    $info.Environment['PGUSER'] = $UserName
    $info.Environment['PGPASSFILE'] = $PasswordFile
    $info.Environment['PGSSLMODE'] = 'verify-full'
    $info.Environment['PGCONNECT_TIMEOUT'] = '15'
    $info.Environment['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=300000'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(600000)) { $process.Kill($true); throw 'Timeout no utilitário PostgreSQL.' }
        # Não reproduz saída ou erro: ferramentas podem incluir detalhes da conexão.
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Utilitário PostgreSQL falhou; backup não validado. Verifique acesso, certificado e versão localmente.' }
    } catch {
        throw 'Utilitário PostgreSQL falhou; nenhum backup deve ser considerado validado.'
    } finally { $process.Dispose() }
}

if ($HostName -notmatch '^[a-zA-Z0-9.-]+$' -or $ExpectedHost -notmatch '^[a-zA-Z0-9.-]+$' -or
    $DatabaseName -notmatch '^[a-zA-Z0-9_]+$' -or $UserName -notmatch '^[a-zA-Z0-9_.-]+$') {
    # Não ecoar parâmetros inválidos: alguém pode ter colado uma URL com senha.
    throw 'Parâmetros de conexão inválidos; informe campos separados, nunca URL ou senha.'
}
if ($HostName -cne $ExpectedHost) { throw 'Host informado difere do host esperado.' }
$BackupRoot = Assert-ExternalPath $BackupRoot $true
if (-not $Execute) {
    Write-Output 'SIMULAÇÃO LOCAL: schemas public + guigs_private; arquivo custom; destino externo validado; nenhuma conexão/arquivo criado.'
    return
}
if ($Acknowledgement -cne 'EXPORTAR_APENAS_LEITURA') { throw 'Execução exige Acknowledgement EXPORTAR_APENAS_LEITURA.' }
if ([string]::IsNullOrWhiteSpace($PasswordFile)) { throw 'Informe PGPASSFILE externo; não forneça senha na linha de comando.' }
$PasswordFile = Assert-ExternalPath $PasswordFile $false
# Resolução antes da criação de qualquer pasta; não baixa ou instala utilitários.
$dump = (Get-Command $PgDumpPath -CommandType Application -ErrorAction Stop).Source
$restore = (Get-Command $PgRestorePath -CommandType Application -ErrorAction Stop).Source
$destination = Join-Path $BackupRoot ('guigs-stock-' + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$null = New-Item -ItemType Directory -Path $destination
$partial = Join-Path $destination 'application.partial'
$archive = Join-Path $destination 'application.dump'
try {
    Invoke-BackupTool $dump @('--no-password','--format=custom','--schema=public','--schema=guigs_private','--lock-wait-timeout=10s',"--file=$partial")
    if (-not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -eq 0) { throw 'Arquivo de backup ausente ou vazio.' }
    # --list lê o arquivo local, sem -d e sem executar restore/SQL.
    Invoke-BackupTool $restore @('--list',$partial)
    Move-Item -LiteralPath $partial -Destination $archive
    $manifest = [ordered]@{
        createdUtc = [DateTime]::UtcNow.ToString('o')
        scope = 'application-only: public,guigs_private; excludes Auth/Storage/global roles/config'
        archive = 'application.dump'
        bytes = (Get-Item -LiteralPath $archive).Length
        sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        validation = 'pg_restore --list; restore drill still required'
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding utf8
    Write-Output "Backup da aplicação criado fora do Git: $destination. Ensaio de restore e proteção externa ainda necessários."
} catch {
    # Preserva o parcial para análise local; nunca apaga ou marca falha como sucesso.
    throw 'Backup incompleto ou não validado; preserve os arquivos externos e investigue. Nenhuma restauração foi executada.'
}
