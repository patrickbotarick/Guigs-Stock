-- Diagnóstico somente leitura. Execute no SQL Editor após a migração 001.
-- Revise o resultado; NÃO amplia permissões e NÃO altera dados.
select c.relname as tabela,c.relrowsecurity as rls_ativo,
 has_table_privilege('anon',c.oid,'SELECT') as anon_select,
 has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
 has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_insert,
 has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_update,
 has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
 ('guigs_shops','guigs_memberships','guigs_products','guigs_lots','guigs_movements')
order by c.relname;
-- Esperado para TODAS as 5 tabelas: rls_ativo=true, anon_select=false,
-- authenticated_select=true, authenticated_insert/update/delete=false.
-- As políticas RLS também devem restringir os registros aos membros ativos.
