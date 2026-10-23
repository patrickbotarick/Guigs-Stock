# Política de backup

Ensaio posterior de 23/10/2026: [pré-produção v1.6](V1.6_PRE_PRODUCAO.md) registra backups reais, cobertura suplementar de dados Auth, restore privado, comparação e limpeza. As observações abaixo sobre a fase 1.6A preservam o histórico; o archive do script continua sendo somente da aplicação.

## Escopo e metas propostas

Antes da próxima mudança de banco, o responsável deve confirmar plano Supabase, disponibilidade/retencão de backups/PITR, responsável e destino privado. Não há backup real gerado ou restauração ensaiada nesta fase.

Proposta: backup diário e imediatamente antes de migration/intervenção; manter 7 diários, 4 semanais e 3 mensais, com expurgo manual aprovado. RPO proposto de até 24 horas entre cópias e RTO inicial de 4 horas são metas a validar em ensaio, não garantias. Para menor perda de dados, avaliar PITR e frequência conforme necessidade do negócio. Manter ao menos uma cópia independente da conta/projeto e uma cópia fora da máquina, criptografadas e com acesso restrito.

## Estrutura

Git é a fonte versionada: `supabase/migrations/001` a `006`, schemas `public` e `guigs_private`, tabelas, constraints, índices, funções, grants e policies. Conservar repositório/refs em cópia privada independente e registrar o SHA correspondente a cada backup. Não colocar credenciais nesse arquivo.

Migrations descrevem o estado esperado, não provam o estado aplicado. Antes de intervenção real, o administrador pode comparar catálogos usando `scripts/audit-production-readonly.sql`. Não executar migrations para fazer essa comparação.

## Dados e recuperação completa

1. **Backup gerenciado/PITR Supabase:** confirmar disponibilidade no plano, ponto recuperável, retenção e procedimento de acesso. Não assumir cobertura com base na versão da aplicação.
2. **Backup lógico da aplicação:** o script abaixo exporta estrutura e dados de `public` e `guigs_private` em um único archive/snapshot. Inclui memberships e referências de usuários; tratar como conteúdo confidencial. Não é backup completo do projeto.
3. **Auth e dependências:** `guigs_memberships.user_id` e `guigs_movements.actor_id` referenciam `auth.users`. O archive da aplicação não inclui Auth (usuários/identidades), roles globais, extensões externas aos schemas selecionados, configurações, chaves, provedores, Edge Functions ou arquivos do Storage. Recuperação total exige backup gerenciado validado ou procedimento oficial Supabase completo, preparado e ensaiado pelo administrador em projeto isolado. Não criar usuários fictícios para satisfazer FKs nem desativar constraints em produção.
4. **Storage:** backups de banco não incluem os arquivos dos buckets; caso seja utilizado, definir cópia separada dos objetos e teste de acesso. Não foi encontrado uso de Storage no frontend atual.
5. CSV manual pode servir para conferência pontual, mas perde dependências/estrutura e não substitui backup consistente. Supabase CLI é alternativa oficial; conferir suas exclusões, versão e cobertura de Auth/Storage antes de utilizá-la. Não instalar, linkar ou executar CLI automaticamente.

## Execução manual do auxiliar Windows

Pré-requisitos: PowerShell 7+, `pg_dump` e `pg_restore` oficiais compatíveis com a versão do servidor; host de conexão direta ou pooler em modo sessão, nunca transaction pooler. Conferir o host no painel privado. Configurar certificado raiz libpq em `%APPDATA%\postgresql\root.crt` conforme documentação do provedor; o script exige `sslmode=verify-full` e não rebaixa TLS.

O administrador cria previamente uma pasta externa a **qualquer repositório Git**, por exemplo `D:\GuigsBackups`, em volume criptografado e com ACL restrita. O script rejeita caminhos relativos, Git, links e junctions. Usa nome único com timestamp; não sobrescreve cópia anterior, não apaga, não restaura e não envia arquivo.

Guardar a senha em arquivo privado externo, usando `PGPASSFILE` e formato `host:porta:banco:usuario:senha`. Não pôr o valor no comando ou Git. Restringir ACL do arquivo no Windows; escapar `:` e `\` segundo libpq. O script não lê/imprime o conteúdo. Desativar gravação de tela/transcrição ao cadastrar credenciais.

```powershell
# SUBSTITUIR os placeholders localmente; nenhuma senha na linha de comando.
$backupArgs = @{
  HostName = 'HOST_CONFIRMADO_NO_PAINEL'
  ExpectedHost = 'HOST_CONFIRMADO_NO_PAINEL'
  DatabaseName = 'postgres'
  UserName = 'USUARIO_CONFIRMADO_NO_PAINEL'
  BackupRoot = 'D:\GuigsBackups'
}
# Só verifica parâmetros/destino; não cria arquivos nem conecta:
.\scripts\backup-production.ps1 @backupArgs

# A partir daqui, execução MANUAL pelo administrador autorizado:
$env:PGPASSFILE = 'D:\CredenciaisPrivadas\pgpass.conf'
.\scripts\backup-production.ps1 @backupArgs -Execute -Acknowledgement EXPORTAR_APENAS_LEITURA
```

Caso os utilitários não estejam no PATH, fornecer `-PgDumpPath` e `-PgRestorePath` com caminhos absolutos de instalações confiáveis. O script remove parâmetros `PG*` herdados no processo filho, exige alvo confirmado, usa conexão TLS validada, impõe modo padrão read-only e limites de espera, não recebe SQL arbitrário e suprime saída potencialmente sensível de ferramentas. Credencial de leitura/exportação precisa enxergar todas as linhas; se RLS/permissões impedirem o dump, abortar e revisar privilégios com administrador, sem modificar RLS ou aceitar cópia parcial.

## Verificação obrigatória

- Confirmar exit code zero, `application.dump` e `manifest.json` (SHA256, tamanho, escopo e data UTC). Falhas preservam arquivo `.partial` e não geram manifesto de sucesso.
- `pg_restore --list` apenas valida leitura do índice do archive; **não comprova integridade de todas as linhas ou restaurabilidade**. Conferir o hash após copiar para o cofre e ensaiar restore isolado periodicamente e antes de confiar na estratégia.
- Registrar privadamente origem, SHA Git, versões de cliente/servidor, backup gerenciado correspondente, responsável e resultado do ensaio. Nunca publicar dumps ou relatórios com dados.
- A verificação por restore exige ambiente privado, aprovado e separado. Não carregar dados reais em desenvolvimento comum; aprovar tratamento/acesso e eliminar cópias conforme política.

Fontes oficiais consultadas em 23/10/2026: [Supabase backups](https://supabase.com/docs/guides/platform/backups), [backup/restore Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [CLI dump](https://supabase.com/docs/reference/cli/supabase-db-dump), [conexões](https://supabase.com/docs/guides/database/connecting-to-postgres), [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), [arquivo de senha libpq](https://www.postgresql.org/docs/current/libpq-pgpass.html).
