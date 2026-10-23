// Apenas gera SQL para revisão. Não conecta nem aplica migrations automaticamente.
const fs=require('node:fs'),path=require('node:path');
function cleanInstall(){
 const directory=path.join(__dirname,'../../supabase/migrations');
 const body=fs.readdirSync(directory).filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort().map(f=>fs.readFileSync(path.join(directory,f),'utf8').replace(/^\s*(begin|commit);\s*$/gmi,'')).join('\n');
 return `do $probe$ declare installed integer;begin
 begin
 alter schema public rename to guigs_homolog_saved_public;
 alter schema guigs_private rename to guigs_homolog_saved_private;
 create schema public;
 grant usage on schema public to anon,authenticated,service_role;
 execute $migrations$${body}$migrations$;
 select count(*) into installed from pg_tables where schemaname='public' and tablename like 'guigs_%';
 if installed<>9 then raise exception 'CLEAN_INSTALL_TABLE_COUNT';end if;
 if exists(select from pg_tables where schemaname='public' and tablename like 'guigs_%' and not rowsecurity)then raise exception 'CLEAN_INSTALL_RLS';end if;
 if not has_function_privilege('authenticated','public.guigs_complete_inventory(uuid,uuid,integer,boolean)','EXECUTE')then raise exception 'CLEAN_INSTALL_GRANT';end if;
 raise exception using errcode='Z1001',message='CLEAN_INSTALL_VALIDATED';
 exception when sqlstate 'Z1001' then null;
 end;
 if to_regnamespace('guigs_homolog_saved_public')is not null or to_regclass('public.guigs_inventories')is null then raise exception 'CLEAN_PROBE_NOT_RESTORED';end if;
end $probe$;`;
}
const temporary=`create schema guigs_homolog_probe; revoke all on schema guigs_homolog_probe from public,anon,authenticated; create table guigs_homolog_probe.control(fail_second boolean not null default false); insert into guigs_homolog_probe.control values(false); create table guigs_homolog_probe.events(pid integer,kind text,at timestamptz default clock_timestamp()); create function guigs_homolog_probe.delay() returns trigger language plpgsql security definer set search_path='' as $$begin if TG_TABLE_NAME='guigs_inventory_items' then if new.counted_quantity is not null and old.counted_quantity is null then insert into guigs_homolog_probe.events(pid,kind)values(pg_backend_pid(),'count'); perform pg_sleep(1);end if; else if new.movement_type='adjust' and new.note like 'Ajuste por inventário%' then if new.location='stock' and (select fail_second from guigs_homolog_probe.control) then raise exception 'HOMOLOG_SECOND_ADJUST_FAILURE';end if;insert into guigs_homolog_probe.events(pid,kind)values(pg_backend_pid(),'adjust');perform pg_sleep(1);end if;end if;return new;end$$; revoke all on function guigs_homolog_probe.delay() from public,anon,authenticated; create trigger homolog_probe_count before update on public.guigs_inventory_items for each row execute function guigs_homolog_probe.delay(); create trigger homolog_probe_adjust before insert on public.guigs_movements for each row execute function guigs_homolog_probe.delay();`;
const cleanup=`drop trigger homolog_probe_count on public.guigs_inventory_items;drop trigger homolog_probe_adjust on public.guigs_movements;drop function guigs_homolog_probe.delay();drop table guigs_homolog_probe.events;drop table guigs_homolog_probe.control;drop schema guigs_homolog_probe;`;
module.exports={cleanInstall,temporary,cleanup};
