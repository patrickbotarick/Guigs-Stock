-- Após criar a conta da atendente via Auth > Users, localize o ID da loja.
-- Substitua os UUIDs abaixo; execute apenas no SQL Editor, em contexto administrativo.
do $$
declare shop_uid uuid := '00000000-0000-0000-0000-000000000000'; attendant_uid uuid := '00000000-0000-0000-0000-000000000000';
begin
 if shop_uid = '00000000-0000-0000-0000-000000000000'::uuid or attendant_uid = '00000000-0000-0000-0000-000000000000'::uuid then
  raise exception 'Substitua shop_uid e attendant_uid pelos IDs reais';
 end if;
 insert into public.guigs_memberships(shop_id,user_id,role) values(shop_uid,attendant_uid,'attendant')
 on conflict (shop_id,user_id) do update set active=true,role='attendant';
end $$;
