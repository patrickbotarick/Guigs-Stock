-- Catálogo por loja. Preserva image_path e objetos legados; nenhum DML de estoque.
begin;
set local lock_timeout='5s';
-- Expande o CHECK legado, sem reescrever valores: agora permite reutilização dentro da mesma loja.
alter table public.guigs_products drop constraint guigs_products_check2;
alter table public.guigs_products add constraint guigs_products_image_path_shop_check check(
 image_path is null or(length(image_path)<=240 and split_part(image_path,'/',1)=shop_id::text and
  (image_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/library/[0-9a-f]{64}[.](png|jpg|webp)$'
   or image_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](png|jpg|webp)$')));
create table public.guigs_product_images(
 id uuid primary key default gen_random_uuid(),
 shop_id uuid not null references public.guigs_shops(id),
 storage_path text not null,
 original_filename text not null check(length(original_filename) between 1 and 240),
 display_name text not null check(length(display_name) between 1 and 160),
 aliases text[] not null default '{}',
 mime_type text not null check(mime_type in ('image/png','image/jpeg','image/webp')),
 bytes bigint not null check(bytes between 1 and 2097152),
 sha256 text check(sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 active boolean not null default true,
 unique(shop_id,storage_path),unique(shop_id,sha256),
 check(split_part(storage_path,'/',1)=shop_id::text),
 check(length(storage_path)<=240)
);
alter table public.guigs_product_images enable row level security;
revoke all on public.guigs_product_images from public,anon,authenticated;
grant select on public.guigs_product_images to authenticated;
create policy guigs_product_images_member_read on public.guigs_product_images for select to authenticated
 using(guigs_private.is_member(shop_id));
create index guigs_products_image_path_idx on public.guigs_products(shop_id,image_path) where image_path is not null;

create or replace function guigs_private.product_image_path_allowed(p_path text,p_owner boolean)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare parts text[]; uuid_pattern constant text := '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';
begin
 if auth.uid() is null or p_path is null or length(p_path)>240 then return false; end if;
 parts:=string_to_array(p_path,'/');
 if p_path ~ ('^'||uuid_pattern||'/library/[0-9a-f]{64}[.](png|jpg|webp)$') then
  return exists(select 1 from public.guigs_memberships m where m.shop_id=parts[1]::uuid
   and m.user_id=(select auth.uid()) and m.active and(not p_owner or m.role='owner' or m.manage_fridge_layout));
 end if;
 if p_path !~ ('^'||uuid_pattern||'/'||uuid_pattern||'/'||uuid_pattern||'[.](png|jpg|webp)$') then return false; end if;
 return exists(select 1 from public.guigs_products p join public.guigs_memberships m on m.shop_id=p.shop_id
  where p.shop_id=parts[1]::uuid and p.id=parts[2]::uuid and m.user_id=(select auth.uid()) and m.active
   and(not p_owner or m.role='owner' or m.manage_fridge_layout));
end $$;
revoke all on function guigs_private.product_image_path_allowed(text,boolean) from public,anon,authenticated;
grant execute on function guigs_private.product_image_path_allowed(text,boolean) to authenticated;

-- Mesmo lock para vínculo, catálogo e exclusão física. Evita associação concorrente a objeto removido.
create function guigs_private.product_image_object_change_allowed(p_path text,p_delete boolean)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
begin
 if not guigs_private.product_image_path_allowed(p_path,true) then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||split_part(p_path,'/',1),0));
 if p_delete then
  return not exists(select 1 from public.guigs_products where image_path=p_path)
   and not exists(select 1 from public.guigs_product_images where storage_path=p_path and active);
 end if;
 return not exists(select 1 from public.guigs_product_images where storage_path=p_path);
end $$;
revoke all on function guigs_private.product_image_object_change_allowed(text,boolean) from public,anon,authenticated;
grant execute on function guigs_private.product_image_object_change_allowed(text,boolean) to authenticated;
-- Objetos catalogados são imutáveis. Troca de imagem muda o vínculo, sem sobrescrever bytes compartilhados.
do $policies$ begin
 if to_regclass('storage.objects') is not null then
  execute $sql$alter policy guigs_product_images_update on storage.objects
   using(bucket_id='guigs-product-images' and guigs_private.product_image_object_change_allowed(name,false))
   with check(bucket_id='guigs-product-images' and guigs_private.product_image_object_change_allowed(name,false))$sql$;
  execute $sql$alter policy guigs_product_images_delete on storage.objects
   using(bucket_id='guigs-product-images' and guigs_private.product_image_object_change_allowed(name,true))$sql$;
  -- Registra a imagem já existente sem mudar o produto. Hash legado permanece desconhecido até leitura autorizada dos bytes.
  execute $sql$insert into public.guigs_product_images(shop_id,storage_path,original_filename,display_name,mime_type,bytes)
   select distinct on(p.shop_id,p.image_path) p.shop_id,p.image_path,split_part(p.image_path,'/',3),left(p.name,160),
    o.metadata->>'mimetype',(o.metadata->>'size')::bigint
   from public.guigs_products p join storage.objects o on o.bucket_id='guigs-product-images' and o.name=p.image_path
   where o.metadata->>'mimetype' in ('image/png','image/jpeg','image/webp') and (o.metadata->>'size') ~ '^[0-9]{1,10}$'
    and (o.metadata->>'size')::bigint between 1 and 2097152 order by p.shop_id,p.image_path,p.id$sql$;
 end if;
end $policies$;

create function public.guigs_register_product_image(p_shop_id uuid,p_path text,p_original_filename text,p_display_name text,p_mime_type text,p_bytes bigint,p_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.guigs_product_images; existing public.guigs_product_images; meta jsonb; ext text;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes not between 1 and 2097152
  or p_mime_type is null or p_mime_type not in ('image/png','image/jpeg','image/webp')
  or p_original_filename is null or length(btrim(p_original_filename)) not between 1 and 240
  or p_original_filename ~ '[/\\]' or p_original_filename ~ '[[:cntrl:]]'
  or p_display_name is null or length(btrim(p_display_name)) not between 1 and 160 then raise exception 'Metadados de imagem inválidos.'; end if;
 if split_part(p_path,'/',1) is distinct from p_shop_id::text or not guigs_private.product_image_path_allowed(p_path,true) then raise exception 'Caminho de imagem inválido.'; end if;
 ext:=case p_mime_type when 'image/png' then 'png' when 'image/jpeg' then 'jpg' else 'webp' end;
 if split_part(p_path,'/',2)='library' and p_path<>p_shop_id::text||'/library/'||p_sha256||'.'||ext then raise exception 'Hash ou extensão do caminho inválido.'; end if;
 if to_regclass('storage.objects') is null then raise exception 'Storage indisponível.'; end if;
 execute 'select metadata from storage.objects where bucket_id=$1 and name=$2' into meta using 'guigs-product-images',p_path;
 if meta is null or meta->>'mimetype' is distinct from p_mime_type or meta->>'size' is distinct from p_bytes::text then raise exception 'Objeto ou metadados do Storage divergentes.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text||':'||p_sha256,0));
 select * into existing from public.guigs_product_images where shop_id=p_shop_id and sha256=p_sha256 for update;
 if found then
  if existing.mime_type<>p_mime_type or existing.bytes<>p_bytes then raise exception 'Hash com metadados divergentes.'; end if;
  update public.guigs_product_images set aliases=case when p_original_filename=original_filename or p_original_filename=any(aliases) then aliases else array_append(aliases,p_original_filename) end,active=true
   where id=existing.id returning * into item;
 else
  select * into existing from public.guigs_product_images where shop_id=p_shop_id and storage_path=p_path for update;
  if found and existing.sha256 is not null and existing.sha256<>p_sha256 then raise exception 'Objeto catalogado não pode mudar de conteúdo.'; end if;
  insert into public.guigs_product_images(shop_id,storage_path,original_filename,display_name,mime_type,bytes,sha256,created_by)
   values(p_shop_id,p_path,p_original_filename,btrim(p_display_name),p_mime_type,p_bytes,p_sha256,auth.uid())
   on conflict(shop_id,storage_path) do update set sha256=excluded.sha256,active=true,
    aliases=case when excluded.original_filename=guigs_product_images.original_filename or excluded.original_filename=any(guigs_product_images.aliases) then guigs_product_images.aliases else array_append(guigs_product_images.aliases,excluded.original_filename) end
   returning * into item;
 end if;
 return to_jsonb(item);
end $$;
revoke all on function public.guigs_register_product_image(uuid,text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.guigs_register_product_image(uuid,text,text,text,text,bigint,text) to authenticated;

create function public.guigs_list_product_images(p_shop_id uuid,p_search text default '',p_limit integer default 60,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
 if length(coalesce(p_search,''))>160 then raise exception 'Busca muito longa.'; end if;
 if p_limit is null or p_limit not between 1 and 60 or p_offset is null or p_offset not between 0 and 100000 then raise exception 'Paginação inválida.'; end if;
 select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(x) order by x.display_name,x.id),'[]'::jsonb)) into result from(
  select i.*,(select coalesce(jsonb_agg(p.name order by p.name),'[]'::jsonb) from public.guigs_products p where p.shop_id=i.shop_id and p.image_path=i.storage_path) as products
  from public.guigs_product_images i where i.shop_id=p_shop_id and i.active
   and (coalesce(p_search,'')='' or position(lower(p_search) in lower(i.display_name||' '||i.original_filename||' '||array_to_string(i.aliases,' ')||' '||coalesce((select string_agg(p.name,' ') from public.guigs_products p where p.shop_id=i.shop_id and p.image_path=i.storage_path),'')))>0)
  order by i.display_name,i.id limit p_limit offset p_offset
 )x;
 return result;
end $$;
revoke all on function public.guigs_list_product_images(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.guigs_list_product_images(uuid,text,integer,integer) to authenticated;

create function public.guigs_archive_product_image(p_shop_id uuid,p_image_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.guigs_product_images;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 select * into item from public.guigs_product_images where shop_id=p_shop_id and id=p_image_id for update;
 if not found then raise exception 'Imagem indisponível.'; end if;
 if exists(select 1 from public.guigs_products where shop_id=p_shop_id and image_path=item.storage_path) then raise exception 'Desvincule os produtos antes de arquivar.'; end if;
 update public.guigs_product_images set active=false where id=item.id;
 return jsonb_build_object('id',item.id,'active',false);
end $$;
revoke all on function public.guigs_archive_product_image(uuid,uuid) from public,anon,authenticated;
grant execute on function public.guigs_archive_product_image(uuid,uuid) to authenticated;

create or replace function public.guigs_set_product_image(p_shop_id uuid,p_product_id uuid,p_path text,p_expected_path text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous_path text; present boolean;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para alterar fotos do mapa.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 select image_path into previous_path from public.guigs_products where shop_id=p_shop_id and id=p_product_id for update;
 if not found then raise exception 'Produto indisponível nesta loja.'; end if;
 if previous_path is distinct from p_expected_path then raise exception 'A foto mudou. Atualize antes de editar.'; end if;
 if p_path is not null then
  if split_part(p_path,'/',1)<>p_shop_id::text or not guigs_private.product_image_path_allowed(p_path,true) then raise exception 'Caminho de imagem inválido.'; end if;
  if to_regclass('storage.objects') is null then raise exception 'Storage indisponível.'; end if;
  if split_part(p_path,'/',2)='library' or split_part(p_path,'/',2)<>p_product_id::text then
   select exists(select 1 from public.guigs_product_images where shop_id=p_shop_id and storage_path=p_path and active) into present;
   if not present then raise exception 'Selecione uma imagem ativa da biblioteca.'; end if;
  end if;
  execute 'select exists(select 1 from storage.objects where bucket_id=$1 and name=$2)' into present using 'guigs-product-images',p_path;
  if not present then raise exception 'Imagem não encontrada no bucket privado.'; end if;
 end if;
 update public.guigs_products set image_path=p_path where shop_id=p_shop_id and id=p_product_id;
 return jsonb_build_object('product_id',p_product_id,'image_path',p_path);
end $$;
revoke all on function public.guigs_set_product_image(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.guigs_set_product_image(uuid,uuid,text,text) to authenticated;
commit;
