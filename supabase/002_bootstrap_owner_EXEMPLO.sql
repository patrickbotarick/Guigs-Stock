-- Execute SOMENTE após criar a conta proprietária no Supabase Auth > Users.
-- SUBSTITUA o UUID de exemplo por auth.users.id real, jamais por email.
-- Execute apenas UMA vez: este script cria uma nova loja.
do $$
declare owner_uid uuid := '00000000-0000-0000-0000-000000000000'; new_shop uuid;
begin
 if owner_uid = '00000000-0000-0000-0000-000000000000'::uuid then
   raise exception 'Substitua owner_uid pelo UUID real da proprietária';
 end if;
 if not exists(select 1 from auth.users where id = owner_uid) then
   raise exception 'Conta não encontrada em auth.users';
 end if;
 insert into public.guigs_shops(name) values ('Pizzaria Guig''s') returning id into new_shop;
 insert into public.guigs_memberships(shop_id,user_id,role) values(new_shop,owner_uid,'owner');
 raise notice 'SHOP ID criado: %',new_shop;
end $$;
