# Procedimento para futuras migrations

Nenhuma migration desta fase foi criada, modificada ou executada. Arquivos históricos são imutáveis: criar uma nova migration incremental para mudanças futuras, sem reescrever as anteriores.

## Inventário estático existente

| Arquivo | Objetos/efeito esperado |
|---|---|
| 001_schema_rls | shops, memberships, products, lots, movements; índices, RLS, policies; guigs_private.is_member |
| 002_cloud_write_operations | helpers member_role/lot_balance, RPCs de produto, recebimento, transferência, venda, perda e ajuste; revokes/grants |
| 003_history_scaling | índice de histórico e guigs_get_lot_balances |
| 004_history_query | guigs_get_history, filtros e paginação |
| 005_history_actors | guigs_get_history_actors |
| 006_homologation_suppliers_fefo | suppliers, supplier_id, FK/índices, RLS, RPCs de fornecedor, overloads de recebimento e consulta FEFO |

006 tem CREATE TABLE/ADD COLUMN sem proteção de reexecução; 001 recria policies e 002 altera permissões. Não são scripts de diagnóstico. O nome “homologation” em 006 não autoriza execução em produção. Scripts 900/901 provisionam loja/membro e não fazem parte da sequência de manutenção. 902 é leitura de permissões antiga de cinco tabelas; não cobre suppliers. O novo roteiro de catálogo cobre seis, sem substituí-lo ou executá-lo.

Migrations são numeradas em três dígitos e aplicadas por procedimento SQL histórico; não existe evidência local suficiente de controle remoto pelo Supabase CLI. Não inicializar `db push`/`migration repair` nem tentar reconciliar histórico automaticamente. Registrar versões aplicadas em controle privado, após conferir banco e backups.

## Fluxo obrigatório

1. Criar branch feature a partir da main atualizada e conferir estado limpo.
2. Preparar migration aditiva; revisar locks, duração, FKs, índices, permissões, RLS, security definer/search_path e dependências de Auth.
3. Testar em banco isolado com dados artificiais; nunca apontar testes para produção.
4. Revisar SQL e plano de rollback/compensação com responsável. Descrever cada alteração e seu impacto no frontend antigo.
5. Administrador autorizado faz backup de produção conforme [BACKUP.md](BACKUP.md), contemplando dependências e ponto temporal.
6. Verificar manifesto/hash, capacidade de recuperação e ensaio isolado; registrar a janela de manutenção e decisão de prosseguir.
7. Somente após autorização explícita, administrador aplica **uma vez** a migration exata revisada, com alvo conferido, limites de espera e transação quando compatível. Parar em erro; não reaplicar em lote.
8. Validar cliente anterior: login, leituras, permissões, histórico e contratos RPC. Qualquer escrita de validação usa ambiente isolado, nunca estoque real fictício.
9. Só então autorizar merge do frontend. Mudança só de frontend registra “migration não necessária”; não cria migration vazia.
10. Monitorar erros, autorização, latência e operação; confirmar estabilidade e guardar evidências privadas.

Preferir expand → migrate → contract: adicionar estrutura compatível, migrar sob plano aprovado, remover somente em fase posterior. Não apagar/renomear coluna ou remover overload RPC sem período de compatibilidade. Migration destrutiva exige aprovação e estratégia explícita de recuperação, incluindo mudanças posteriores ao backup e perda aceitável. Não existe rollback SQL genérico seguro: frequentemente a correção aditiva é preferível à reversão. Não executar DROP/DOWN por impulso.
