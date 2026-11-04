-- v1.7K: bucket privado criado pela Storage API, nunca por INSERT em storage.buckets.
begin;
set local lock_timeout='5s';

create function guigs_private.product_image_path_allowed(p_path text,p_owner boolean)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare parts text[];
begin
  if auth.uid() is null or p_path is null or length(p_path)>240
    or p_path !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](png|jpg|webp)$'
  then return false; end if;
  parts:=string_to_array(p_path,'/');
  return exists(select 1 from public.guigs_products p join public.guigs_memberships m on m.shop_id=p.shop_id
    where p.shop_id=parts[1]::uuid and p.id=parts[2]::uuid and m.user_id=(select auth.uid()) and m.active
      and (not p_owner or m.role='owner'));
end $$;
revoke all on function guigs_private.product_image_path_allowed(text,boolean) from public,anon,authenticated;
grant execute on function guigs_private.product_image_path_allowed(text,boolean) to authenticated;

-- O schema storage existe no Supabase hospedado; PGlite local não simula o serviço.
do $policies$ begin
  if to_regclass('storage.objects') is not null then
    execute $sql$
      create policy guigs_product_images_read on storage.objects for select to authenticated
      using(bucket_id='guigs-product-images' and guigs_private.product_image_path_allowed(name,false))
    $sql$;
    execute $sql$
      create policy guigs_product_images_insert on storage.objects for insert to authenticated
      with check(bucket_id='guigs-product-images' and guigs_private.product_image_path_allowed(name,true))
    $sql$;
  end if;
end $policies$;

create function public.guigs_set_product_image(p_shop_id uuid,p_product_id uuid,p_path text,p_expected_path text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous_path text; present boolean;
begin
  if auth.uid() is null or guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Somente proprietários podem alterar fotos.';
  end if;
  select image_path into previous_path from public.guigs_products where shop_id=p_shop_id and id=p_product_id for update;
  if not found then raise exception 'Produto indisponível nesta loja.'; end if;
  if previous_path is distinct from p_expected_path then raise exception 'A foto mudou. Atualize antes de editar.'; end if;
  if p_path is not null then
    if not guigs_private.product_image_path_allowed(p_path,true)
      or split_part(p_path,'/',1)<>p_shop_id::text or split_part(p_path,'/',2)<>p_product_id::text then
      raise exception 'Caminho de imagem inválido.';
    end if;
    if to_regclass('storage.objects') is null then raise exception 'Storage indisponível neste ambiente.'; end if;
    execute 'select exists(select 1 from storage.objects where bucket_id=$1 and name=$2)'
      into present using 'guigs-product-images',p_path;
    if not present then raise exception 'Imagem não encontrada no bucket privado.'; end if;
  end if;
  update public.guigs_products set image_path=p_path where shop_id=p_shop_id and id=p_product_id;
  return jsonb_build_object('product_id',p_product_id,'image_path',p_path);
end $$;
revoke all on function public.guigs_set_product_image(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.guigs_set_product_image(uuid,uuid,text,text) to authenticated;
commit;
