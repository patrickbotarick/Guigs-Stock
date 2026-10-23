-- MANUAL / OPCIONAL: revisar e executar somente com autorização para leitura administrativa.
-- Nenhum dado de negócio, auth.users, email ou senha é consultado.
-- Não comprova quais migrations foram aplicadas; compara apenas objetos presentes.
begin transaction read only;
set local statement_timeout = '15s';

select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname in
 ('guigs_shops','guigs_memberships','guigs_products','guigs_lots','guigs_movements','guigs_suppliers')
order by c.relname;

select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name like 'guigs_%'
order by table_name, ordinal_position;

select n.nspname as schema_name, p.proname as function_name,
 pg_catalog.pg_get_function_identity_arguments(p.oid) as signature, p.prosecdef as security_definer
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname like 'guigs_%') or n.nspname = 'guigs_private'
order by n.nspname, p.proname, signature;

select schemaname, tablename, policyname, roles, cmd
from pg_catalog.pg_policies
where schemaname = 'public' and tablename like 'guigs_%'
order by tablename, policyname;

select schemaname, tablename, indexname
from pg_catalog.pg_indexes
where schemaname = 'public' and tablename like 'guigs_%'
order by tablename, indexname;

select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name like 'guigs_%' and grantee in ('anon','authenticated')
order by table_name, grantee, privilege_type;

select to_regclass('supabase_migrations.schema_migrations') is not null as migration_history_table_exists;
rollback;
