-- Administração visual; nenhuma alteração de estoque, capacidade ou ledger.
-- Storage é removido exclusivamente pela API. A fila privada torna falhas retomáveis.
begin;
set local lock_timeout='5s';

create table guigs_private.product_image_deletions(
 image_id uuid primary key,
 shop_id uuid not null references public.guigs_shops(id),
 storage_path text not null unique,
 image jsonb not null,
 requested_by uuid not null references auth.users(id),
 requested_at timestamptz not null default now(),
 check(split_part(storage_path,'/',1)=shop_id::text)
);
create index product_image_deletions_shop_idx on guigs_private.product_image_deletions(shop_id);
alter table guigs_private.product_image_deletions enable row level security;
revoke all on guigs_private.product_image_deletions from public,anon,authenticated;

create function guigs_private.guard_image_catalog_registration()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('image:'||new.shop_id::text,0));
 if exists(select 1 from guigs_private.product_image_deletions where shop_id=new.shop_id and storage_path=new.storage_path)
 then raise exception 'Exclusão de imagem pendente. Conclua ou cancele em Gerenciar imagens.'; end if;
 return new;
end $$;
revoke all on function guigs_private.guard_image_catalog_registration() from public,anon,authenticated;
create trigger guigs_image_registration_guard before insert or update on public.guigs_product_images
 for each row execute function guigs_private.guard_image_catalog_registration();

create function guigs_private.guard_image_association()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.image_path is null or new.image_path is not distinct from old.image_path then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||new.shop_id::text,0));
 if exists(select 1 from guigs_private.product_image_deletions where shop_id=new.shop_id and storage_path=new.image_path)
 then raise exception 'Esta imagem está com exclusão pendente.'; end if;
 if exists(select 1 from public.guigs_product_images where shop_id=new.shop_id and storage_path=new.image_path and not active)
 then raise exception 'Selecione uma imagem ativa da biblioteca.'; end if;
 return new;
end $$;
revoke all on function guigs_private.guard_image_association() from public,anon,authenticated;
create trigger guigs_image_association_guard before update of image_path on public.guigs_products
 for each row execute function guigs_private.guard_image_association();

create function guigs_private.product_image_upload_allowed(p_path text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if not guigs_private.product_image_path_allowed(p_path,true) then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||split_part(p_path,'/',1),0));
 return not exists(select 1 from guigs_private.product_image_deletions where storage_path=p_path);
end $$;
revoke all on function guigs_private.product_image_upload_allowed(text) from public,anon,authenticated;
grant execute on function guigs_private.product_image_upload_allowed(text) to authenticated;

create or replace function guigs_private.product_image_object_change_allowed(p_path text,p_delete boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if not guigs_private.product_image_path_allowed(p_path,true) then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||split_part(p_path,'/',1),0));
 if p_delete then
  return not exists(select 1 from public.guigs_products where image_path=p_path)
   and not exists(select 1 from public.guigs_product_images where storage_path=p_path);
 end if;
 return not exists(select 1 from public.guigs_product_images where storage_path=p_path)
  and not exists(select 1 from guigs_private.product_image_deletions where storage_path=p_path);
end $$;
revoke all on function guigs_private.product_image_object_change_allowed(text,boolean) from public,anon,authenticated;
grant execute on function guigs_private.product_image_object_change_allowed(text,boolean) to authenticated;
do $$ begin
 if to_regclass('storage.objects') is not null then
  execute $sql$alter policy guigs_product_images_insert on storage.objects
   with check(bucket_id='guigs-product-images' and guigs_private.product_image_upload_allowed(name))$sql$;
 end if;
end $$;

create function public.guigs_list_image_admin(p_shop_id uuid,p_search text default '',p_status text default 'all',p_limit integer default 60,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 if p_status is null or p_status not in ('all','active','inactive','pending') or length(coalesce(p_search,''))>160
  or p_limit is null or p_limit not between 1 and 60 or p_offset is null or p_offset not between 0 and 100000 then raise exception 'Filtro inválido.'; end if;
 with images as (
  select to_jsonb(i)||jsonb_build_object('deletion_pending',false) as item from public.guigs_product_images i where shop_id=p_shop_id
  union all select d.image||jsonb_build_object('deletion_pending',true) from guigs_private.product_image_deletions d where shop_id=p_shop_id
 ), enriched as (
  select item||jsonb_build_object('products',(select coalesce(jsonb_agg(p.name order by p.name),'[]'::jsonb) from public.guigs_products p where p.shop_id=p_shop_id and p.image_path=item->>'storage_path'),
   'object_exists',exists(select 1 from storage.objects o where o.bucket_id='guigs-product-images' and o.name=item->>'storage_path')) as item from images
 ), page as (
  select item from enriched where
   (p_status='all' or p_status='pending' and (item->>'deletion_pending')::boolean
    or p_status='active' and (item->>'active')::boolean and not (item->>'deletion_pending')::boolean
    or p_status='inactive' and not (item->>'active')::boolean and not (item->>'deletion_pending')::boolean)
   and (coalesce(p_search,'')='' or position(lower(p_search) in lower((item->>'display_name')||' '||(item->>'original_filename')||' '||(item->'products')::text))>0)
  order by item->>'display_name',item->>'id' limit p_limit offset p_offset
 ) select jsonb_build_object('items',coalesce(jsonb_agg(item order by item->>'display_name',item->>'id'),'[]'::jsonb)) into result from page;
 return result;
end $$;

create function public.guigs_edit_product_image(p_shop_id uuid,p_image_id uuid,p_action text,p_display_name text,p_expected_name text,p_expected_active boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.guigs_product_images;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 select * into item from public.guigs_product_images where shop_id=p_shop_id and id=p_image_id for update;
 if not found then raise exception 'Imagem indisponível. Atualize a biblioteca.'; end if;
 if item.display_name is distinct from p_expected_name or item.active is distinct from p_expected_active then raise exception 'A imagem mudou. Atualize a biblioteca.'; end if;
 if p_action='rename' then
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 160 or p_display_name ~ '[[:cntrl:]]' then raise exception 'Informe um nome de 1 a 160 caracteres.'; end if;
  update public.guigs_product_images set display_name=btrim(p_display_name) where id=item.id returning * into item;
 elsif p_action in ('deactivate','reactivate') then
  if p_action='reactivate' and not exists(select 1 from storage.objects where bucket_id='guigs-product-images' and name=item.storage_path) then raise exception 'Arquivo ausente. Restaure a imagem antes de reativar.'; end if;
  update public.guigs_product_images set active=(p_action='reactivate') where id=item.id returning * into item;
 else raise exception 'Ação inválida.';
 end if;
 return to_jsonb(item);
end $$;

create function public.guigs_begin_image_delete(p_shop_id uuid,p_image_id uuid,p_expected_name text,p_expected_active boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.guigs_product_images; job guigs_private.product_image_deletions;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 select * into job from guigs_private.product_image_deletions where shop_id=p_shop_id and image_id=p_image_id;
 if found then return job.image||jsonb_build_object('deletion_pending',true); end if;
 select * into item from public.guigs_product_images where shop_id=p_shop_id and id=p_image_id for update;
 if not found then raise exception 'Imagem indisponível. Atualize a biblioteca.'; end if;
 if exists(select 1 from public.guigs_products where image_path=item.storage_path) then raise exception 'Esta imagem está sendo utilizada e não pode ser excluída.'; end if;
 if item.display_name is distinct from p_expected_name or item.active is distinct from p_expected_active then raise exception 'A imagem mudou. Atualize a biblioteca.'; end if;
 insert into guigs_private.product_image_deletions(image_id,shop_id,storage_path,image,requested_by)
  values(item.id,item.shop_id,item.storage_path,to_jsonb(item),auth.uid());
 delete from public.guigs_product_images where id=item.id;
 return to_jsonb(item)||jsonb_build_object('deletion_pending',true);
end $$;

create function public.guigs_finish_image_delete(p_shop_id uuid,p_image_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job guigs_private.product_image_deletions;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 select * into job from guigs_private.product_image_deletions where shop_id=p_shop_id and image_id=p_image_id for update;
 if not found then
  if exists(select 1 from public.guigs_product_images where id=p_image_id) then raise exception 'Exclusão não iniciada.'; end if;
  return jsonb_build_object('deleted',true);
 end if;
 if exists(select 1 from storage.objects where bucket_id='guigs-product-images' and name=job.storage_path) then raise exception 'O arquivo ainda existe. Tente concluir a exclusão.'; end if;
 delete from guigs_private.product_image_deletions where image_id=job.image_id;
 return jsonb_build_object('deleted',true);
end $$;

create function public.guigs_cancel_image_delete(p_shop_id uuid,p_image_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job guigs_private.product_image_deletions;
begin
 if auth.uid() is null or not guigs_private.can_manage_fridge_layout(p_shop_id) then raise exception 'Sem permissão para gerenciar imagens.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('image:'||p_shop_id::text,0));
 select * into job from guigs_private.product_image_deletions where shop_id=p_shop_id and image_id=p_image_id for update;
 if not found then raise exception 'Exclusão pendente não encontrada.'; end if;
 if not exists(select 1 from storage.objects where bucket_id='guigs-product-images' and name=job.storage_path) then raise exception 'O arquivo já foi removido. Conclua a exclusão.'; end if;
 delete from guigs_private.product_image_deletions where image_id=job.image_id;
 insert into public.guigs_product_images select * from jsonb_populate_record(null::public.guigs_product_images,job.image);
 return job.image;
end $$;

revoke all on function public.guigs_list_image_admin(uuid,text,text,integer,integer) from public,anon,authenticated;
revoke all on function public.guigs_edit_product_image(uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.guigs_begin_image_delete(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.guigs_finish_image_delete(uuid,uuid) from public,anon,authenticated;
revoke all on function public.guigs_cancel_image_delete(uuid,uuid) from public,anon,authenticated;
grant execute on function public.guigs_list_image_admin(uuid,text,text,integer,integer) to authenticated;
grant execute on function public.guigs_edit_product_image(uuid,uuid,text,text,text,boolean) to authenticated;
grant execute on function public.guigs_begin_image_delete(uuid,uuid,text,boolean) to authenticated;
grant execute on function public.guigs_finish_image_delete(uuid,uuid) to authenticated;
grant execute on function public.guigs_cancel_image_delete(uuid,uuid) to authenticated;
commit;
