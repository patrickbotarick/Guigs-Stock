// Emite SQL de sonda descartável; não executa nem conecta.
const shop=process.argv[2];
if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(shop||''))throw Error('UUID da loja artificial obrigatório');
console.log(`create function public.guigs_v17_overlap_probe(p_shop_id uuid) returns integer language plpgsql set search_path='' as $$
begin
 if p_shop_id is distinct from '${shop}'::uuid or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado'; end if;
 perform pg_sleep(0.3);
 return pg_backend_pid();
end $$;
revoke all on function public.guigs_v17_overlap_probe(uuid) from public,anon,authenticated;
grant execute on function public.guigs_v17_overlap_probe(uuid) to authenticated;
-- Ao terminar, revogue acesso e remova apenas a função de sonda (não faz parte das migrations).
-- revoke all on function public.guigs_v17_overlap_probe(uuid) from public,anon,authenticated;
-- drop function public.guigs_v17_overlap_probe(uuid);`);
