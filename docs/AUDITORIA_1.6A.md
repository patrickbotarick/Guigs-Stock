# Auditoria estática — v1.6A

Data: 23/10/2026. Base `17cf2a832d26b7071452ee377d80e4b3f5efba2d`.

## Git inicial

- main limpa, sem arquivos não rastreados; origin/main e v1.5.0 exatamente no SHA esperado após fetch/pull ff-only.
- Branch criada: `feature/1.6a-production-protection`, da base acima.
- Branches antigas preservadas: feature/1.2c-cloud-integration, feature/1.3-ux-ui, feature/1.4-pwa, feature/1.5-homologation-adjustments, feature/1.5-searchable-selects-ui-fix e release/1.2. Nenhuma apagada.
- `.gitignore` original protegia config.js, logs e arquivos locais básicos, mas não tinha regras para .env, dumps ou credenciais.

## Segredos

Auditoria inicial de todos os 42 arquivos rastreados e de todos os 42 commits alcançáveis, com 100 blobs históricos únicos. Scanner local sem imprimir valores + revisão contextual de configuração, scripts, SQLs, documentos e fixtures. Não foram encontrados candidatos a segredo real, JWT, chave privilegiada, URL com senha, credencial Cloudflare/GitHub, e-mail pessoal ou dump de dados reais. Referências a service_role/sb_secret nos arquivos são instruções de proteção; config.example.js contém placeholders; testes usam identidades em test.invalid e senha artificial test-only. Não há necessidade de rotação identificada por esta auditoria.

`config.js` não rastreado e confirmado ignorado. Arquivos ignorados/credenciais locais não foram lidos. O scanner é heurístico: nenhum achado não garante ausência absoluta, nem cobre commits inalcançáveis, forks/caches, logs externos ou segredos remotos. Um achado futuro deve registrar somente arquivo/tipo/risco e acionar revogação/rotação, sem copiar valor para o relatório. Não foi necessário reescrever histórico.

A ampliação da busca gerou um candidato em `reset-password.js:39`, confirmado como falso positivo: mensagem de erro da interface, sem senha embutida. O detector foi ajustado para distinguir atribuições de credenciais e mensagens, com teste de regressão. Mensagens dos commits também são examinadas. Metadados públicos de autoria Git contêm e-mail de autor; não é credencial, mas há exposição de contato: considerar endereço noreply em futuros commits. O valor não é reproduzido neste relatório.

## Riscos identificados e tratados/documentados

- Supabase real é compartilhado por qualquer frontend que use a configuração de produção; branch feature/preview não isola backend.
- Documentação antiga fala em piloto/testes e inclui SQL de bootstrap; a política atual prevalece e o uso desses scripts em produção foi explicitamente proibido sem procedimento/autorização.
- Não há evidência acessada de backup gerenciado ativo, retenção/PITR, restore ensaiado, Rulesets do GitHub ou configuração Cloudflare. São verificações pendentes do administrador; não foram presumidas nem alteradas.
- Arquivo lógico só da aplicação não recupera Auth/Storage/roles/configuração. O novo script inclui guigs_private e declara essa limitação; recuperação completa exige plano Supabase validado.
- Dumps e arquivos de senha contêm informações confidenciais; novos ignores são apenas defesa adicional. O script exige destino fora de qualquer árvore Git, sem symlinks/junctions, além de armazenamento criptografado/ACL privada como responsabilidade do operador.
- Ferramentas pg_dump/pg_restore/psql não estavam disponíveis no PATH. Nenhum utilitário foi instalado, nenhum backup real executado e nenhuma conexão ao banco foi aberta.
- Nenhuma migration ou SQL foi executado, mesmo em banco local. Inventário de migrations foi feito somente por leitura dos arquivos.

## Validação desta fase

Ver comandos no [checklist de produção](CHECKLIST_PRODUCAO.md). Testes do auxiliar de backup usam executável artificial local, sem rede, para verificar plano, bloqueios, argumentos, manifesto/hash e falhas. Não são ensaio de restauração PostgreSQL. Testes de navegador utilizam Supabase simulado. Nenhuma alteração de UI, regra de estoque, migration, RLS, RPC, config.js ou variável de produção faz parte do diff.

Resultados: 40 verificações estáticas de segurança, 25 verificações do auxiliar PowerShell, 45 regressões de navegador e 110 verificações dos seletores aprovadas. Sintaxe Node/PowerShell e `git diff --check` aprovados. Auditoria final do conjunto preparado para commit: 55 arquivos rastreados, zero candidatos. Os 42 commits iniciais e 100 blobs históricos foram examinados sem achados pendentes. A execução de binários de teste/navegador exigiu sair do sandbox local; não exigiu conexão ao Supabase.

Nenhum dado real foi alterado. Nenhuma migration foi criada, modificada ou executada. Main e v1.5.0 preservadas. Nenhum merge, tag, release ou deploy foi realizado.
