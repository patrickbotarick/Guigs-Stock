# Produção e segurança — v1.6A

Os dados do Supabase de produção são dados reais e não devem ser utilizados como ambiente de desenvolvimento ou teste.

Qualquer operação destrutiva ou restore exige aprovação explícita do responsável pelo sistema.

## Ambientes e responsabilidade

| Recurso | Classificação |
|---|---|
| `main` | Produção; nenhuma alteração direta, merge somente autorizado |
| Cloudflare Pages / branch main | Frontend de produção |
| Supabase atualmente configurado | Banco real de produção, independentemente da branch ou URL do frontend |
| `feature/*` | Desenvolvimento; uma preview não transforma o backend em homologação |
| Testes locais com mocks e dados artificiais | Homologação técnica |
| Projeto Supabase separado, explicitamente identificado | Homologação de integração com dados artificiais, quando provisionado pelo responsável |

Responsável pelo sistema autoriza intervenções, define janela e perda aceitável; administrador executa backup/restore e controla acesso; desenvolvedor prepara branch, revisão e testes isolados. Registrar nomes e contatos em local privado antes da próxima release. Não registrar contatos pessoais/credenciais no Git público.

## Regras operacionais

- Nunca usar produção para teste destrutivo, seed, reset, bootstrap ou movimentação fictícia.
- Não executar migrations históricas em lote em um banco existente. `supabase/900*` e `901*` são exemplos de provisionamento com escrita, não ferramentas de manutenção.
- Não abrir frontend local/preview com configuração de produção para testar operações. Iniciadores locais e túnel Cloudflare antigos não isolam o banco e não são ferramentas de homologação segura.
- Não colocar senha, service_role, sb_secret, token GitHub/Cloudflare ou chave privada no navegador. URL/publishable key são identificadores públicos; RLS e RPCs continuam sendo a fronteira de autorização.
- `config.js` permanece ignorado e não foi alterado. Não usar `git add -f`, upload de dumps em issues, logs públicos ou anexos de PR.
- Dumps não são criptografados pelo script. Usar volume externo criptografado com ACL restrita ao administrador; cópia fora da máquina em cofre aprovado, criptografada, com retenção controlada.
- Nunca servir a pasta de backup por HTTP/túnel. O `.gitignore` reduz acidentes, mas não protege arquivos já rastreados nem substitui controle de acesso.
- Branch protection/Rulesets, revisão obrigatória, proibição de force push/main, secret scanning/push protection e revisão do acesso ao repositório são recomendações para configuração manual. Nada disso foi ativado remotamente nesta fase.
- Revisar controles de preview do Cloudflare: um push de feature pode disparar build automático se habilitado. Nenhuma configuração Cloudflare foi alterada. Não assumir que frontend rollback reverte banco ou cache PWA.

## Auditoria e ferramentas locais

`node scripts/audit-repository.cjs` lê todos os arquivos rastreados atuais e blobs únicos dos últimos 100 commits alcançáveis por refs locais (inclui branches/tags obtidas no fetch). Só reporta arquivo, linha, categoria e commit; nunca valores. Candidatos exigem revisão; código de saída 1 bloqueia a liberação até triagem. Não cobre commits inalcançáveis, forks, caches externos, logs de serviços ou arquivos ignorados; não é prova matemática de ausência de segredo.

`scripts/audit-production-readonly.sql` é um roteiro opcional de catálogo, sem consultas a dados operacionais ou usuários. Contém transação READ ONLY, limite de duração e ROLLBACK. Não foi executado; não comprova aplicação de migrations nem equivale a auditoria completa das policies/RPCs.

Documentos antigos permanecem como histórico; em caso de conflito, esta política e os procedimentos desta pasta prevalecem para produção. Ver [backup](BACKUP.md), [migrations](MIGRATIONS_SEGURAS.md), [recuperação](RECUPERACAO.md), [checklist](CHECKLIST_PRODUCAO.md) e [emergência](EMERGENCIA.md).
