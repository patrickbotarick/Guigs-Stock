-- v1.7H: mesmo cabeçalho/auditoria da 007; partições explícitas no snapshot.
begin;
set local lock_timeout='5s';

alter table public.guigs_inventories add column spatial boolean not null default false;
alter table public.guigs_inventory_items
  add column slot_id uuid,
  add column fridge_id uuid,
  add column shelf_id uuid,
  add column slot_label text,
  add constraint guigs_inventory_slot_fk foreign key(shop_id,slot_id) references public.guigs_fridge_slots(shop_id,id),
  add constraint guigs_inventory_partition_shape check (
    (slot_id is null and fridge_id is null and shelf_id is null and slot_label is null)
    or (slot_id is not null and location='fridge' and fridge_id is not null and shelf_id is not null and slot_label is not null)
  );
alter table public.guigs_inventory_items drop constraint guigs_inventory_items_inventory_id_lot_id_location_key;
alter table public.guigs_inventory_items add constraint guigs_inventory_partition_key
  unique nulls not distinct(inventory_id,lot_id,location,slot_id);
create index guigs_inventory_items_slot_idx on public.guigs_inventory_items(shop_id,slot_id) where slot_id is not null;

create function guigs_private.spatial_inventory_scope(p_shop uuid)
returns table(lot_id uuid,product_id uuid,product_name text,lot_code text,expiry date,supplier_name text,
  location text,slot_id uuid,fridge_id uuid,shelf_id uuid,slot_label text,quantity bigint,events bigint)
language sql stable set search_path='' as $$
  with buckets as materialized (
    select m.lot_id,m.location,m.slot_id,sum(m.delta)::bigint as quantity,count(*) as events
    from public.guigs_movements m where m.shop_id=p_shop group by m.lot_id,m.location,m.slot_id
  ), batches as materialized (
    select l.id,l.product_id,p.name,l.code,l.expiry,s.name as supplier
    from public.guigs_lots l join public.guigs_products p on (p.shop_id,p.id)=(l.shop_id,l.product_id)
    left join public.guigs_suppliers s on (s.shop_id,s.id)=(l.shop_id,l.supplier_id)
    where l.shop_id=p_shop and (p.active or exists(select 1 from buckets b where b.lot_id=l.id and b.quantity>0))
  ), slots as materialized (
    select x.id,x.product_id,x.fridge_id,x.shelf_id,f.name||' / '||h.name||' / '||x.name as label
    from public.guigs_fridge_slots x join public.guigs_fridge_shelves h
      on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
    join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
    where x.shop_id=p_shop and x.active and h.active and f.active
  ), partitions as (
    select l.id as lot_id,x.location,null::uuid as slot_id from batches l
      cross join (values ('stock'::text),('fridge'::text)) x(location)
    union
    select l.id,'fridge',s.id from batches l join slots s on s.product_id=l.product_id
    union
    select b.lot_id,b.location,b.slot_id from buckets b join slots s on s.id=b.slot_id where b.quantity>0
  )
  select l.id,l.product_id,l.name,l.code,l.expiry,l.supplier,q.location,q.slot_id,s.fridge_id,s.shelf_id,s.label,
    coalesce(b.quantity,0),coalesce(b.events,0)
  from partitions q join batches l on l.id=q.lot_id
  left join slots s on s.id=q.slot_id
  left join buckets b on b.lot_id=q.lot_id and b.location=q.location and b.slot_id is not distinct from q.slot_id;
$$;
revoke all on function guigs_private.spatial_inventory_scope(uuid) from public,anon,authenticated;

create function guigs_private.spatial_inventory_add_items(p_shop uuid,p_inventory uuid)
returns integer language plpgsql set search_path='' as $$
declare added integer;
begin
  insert into public.guigs_inventory_items(shop_id,inventory_id,lot_id,product_id,product_name,lot_code,expiry,supplier_name,
    location,slot_id,fridge_id,shelf_id,slot_label,expected_initial,initial_movement_count,basis_quantity,basis_movement_count)
  select p_shop,p_inventory,s.lot_id,s.product_id,s.product_name,s.lot_code,s.expiry,s.supplier_name,
    s.location,s.slot_id,s.fridge_id,s.shelf_id,s.slot_label,s.quantity,s.events,s.quantity,s.events
  from guigs_private.spatial_inventory_scope(p_shop) s
  on conflict on constraint guigs_inventory_partition_key do nothing;
  get diagnostics added=row_count;
  return added;
end $$;
revoke all on function guigs_private.spatial_inventory_add_items(uuid,uuid) from public,anon,authenticated;

create function guigs_private.spatial_inventory_missing(p_shop uuid,p_inventory uuid)
returns integer language sql stable set search_path='' as $$
  select count(*)::integer from guigs_private.spatial_inventory_scope(p_shop) s
  where not exists(select 1 from public.guigs_inventory_items i
    where i.shop_id=p_shop and i.inventory_id=p_inventory and i.lot_id=s.lot_id
      and i.location=s.location and i.slot_id is not distinct from s.slot_id);
$$;
revoke all on function guigs_private.spatial_inventory_missing(uuid,uuid) from public,anon,authenticated;

create function guigs_private.freeze_spatial_inventory_layout() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from public.guigs_inventories where shop_id=new.shop_id and spatial and status in ('open','review')) then
    raise exception 'Finalize ou cancele o inventário espacial antes de editar o layout.';
  end if;
  return new;
end $$;
revoke all on function guigs_private.freeze_spatial_inventory_layout() from public,anon,authenticated;
create trigger guigs_fridge_inventory_freeze before insert or update on public.guigs_fridges
  for each row execute function guigs_private.freeze_spatial_inventory_layout();
create trigger guigs_shelf_inventory_freeze before insert or update on public.guigs_fridge_shelves
  for each row execute function guigs_private.freeze_spatial_inventory_layout();
create trigger guigs_slot_inventory_freeze before insert or update on public.guigs_fridge_slots
  for each row execute function guigs_private.freeze_spatial_inventory_layout();

-- As funções 007 conservam suas assinaturas. Os comandos novos usam snapshot espacial.
create or replace function guigs_private.spatial_ledger_guard() returns trigger
language plpgsql set search_path='' as $$
declare s record; v_product uuid; v_lot_balance bigint; v_slot_balance bigint;
begin
  if new.location <> 'fridge' then return new; end if;
  -- Legacy writers already lock this row. Reuse that boundary, never upgrade the table lock here.
  select l.product_id into v_product from public.guigs_lots l
    where l.shop_id=new.shop_id and l.id=new.lot_id for update;
  if new.slot_id is null and not new.spatial then
    if exists(select 1 from public.guigs_movements m where m.shop_id=new.shop_id and m.lot_id=new.lot_id
       and m.slot_id is not null group by m.slot_id having sum(m.delta)>0) then
      raise exception 'Lote com posição física. Use o Mapa de Geladeiras para movimentá-lo.';
    end if;
    return new;
  end if;
  if exists(select 1 from public.guigs_inventories i where i.shop_id=new.shop_id and not i.spatial and i.status in ('open','review')) then
    raise exception 'Finalize ou cancele o inventário ativo antes de movimentar posições.';
  end if;
  select coalesce(sum(m.delta),0) into v_lot_balance from public.guigs_movements m
    where m.shop_id=new.shop_id and m.lot_id=new.lot_id and m.location='fridge'
      and m.slot_id is not distinct from new.slot_id;
  if v_lot_balance+new.delta<0 then raise exception 'Saldo insuficiente na posição de origem.'; end if;
  if new.slot_id is null then return new; end if;
  select x.product_id,x.capacity_quantity,x.active and h.active and f.active as available,
    f.name||' / '||h.name||' / '||x.name as label into s
  from public.guigs_fridge_slots x join public.guigs_fridge_shelves h
    on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
    join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
  where x.shop_id=new.shop_id and x.id=new.slot_id for update of x;
  if not found or not s.available then raise exception 'Posição física indisponível.'; end if;
  if new.delta>0 then
    if s.product_id is not null and s.product_id is distinct from v_product then
      raise exception 'Produto incompatível com a posição.';
    end if;
    select coalesce(sum(m.delta),0) into v_slot_balance from public.guigs_movements m
      where m.shop_id=new.shop_id and m.slot_id=new.slot_id;
    if v_slot_balance+new.delta>s.capacity_quantity then raise exception 'Capacidade da posição excedida.'; end if;
  end if;
  new.slot_label:=s.label;
  return new;
end $$;

create or replace function guigs_private.reject_legacy_inventory_with_slots() returns trigger
language plpgsql set search_path='' as $$
begin
  if not new.spatial and exists(select 1 from public.guigs_movements m where m.shop_id=new.shop_id and m.slot_id is not null
      group by m.slot_id,m.lot_id having sum(m.delta)>0) then
    raise exception 'Há estoque em posições físicas. Use o inventário espacial.';
  end if;
  return new;
end $$;

create or replace function guigs_private.inventory_lock(p_shop uuid,p_inventory uuid,p_owner boolean)
returns public.guigs_inventories language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories;
begin
  if guigs_private.member_role(p_shop) is null then raise exception 'Acesso negado.'; end if;
  if p_owner and guigs_private.member_role(p_shop) is distinct from 'owner' then raise exception 'Apenas proprietários podem administrar inventário.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop and id=p_inventory for update;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if v.spatial then raise exception 'Use o inventário espacial da v1.7.'; end if;
  if v.status in ('completed','cancelled') then raise exception 'Inventário encerrado: somente leitura.'; end if;
  return v;
end $$;

create or replace function guigs_private.inventory_add_items(p_shop uuid,p_inventory uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_added integer;
begin
  insert into public.guigs_inventory_items(shop_id,inventory_id,lot_id,product_id,product_name,lot_code,expiry,supplier_name,
    location,expected_initial,initial_movement_count,basis_quantity,basis_movement_count)
  select p_shop,p_inventory,l.id,p.id,p.name,l.code,l.expiry,s.name,x.location,
    coalesce(sum(m.delta),0),count(m.id),coalesce(sum(m.delta),0),count(m.id)
  from public.guigs_lots l join public.guigs_products p on p.shop_id=l.shop_id and p.id=l.product_id
  left join public.guigs_suppliers s on s.shop_id=l.shop_id and s.id=l.supplier_id
  cross join (values('stock'::text),('fridge'::text)) x(location)
  left join public.guigs_movements m on m.shop_id=l.shop_id and m.lot_id=l.id and m.location=x.location
  where l.shop_id=p_shop and (p.active or exists(select 1 from public.guigs_movements b
    where b.shop_id=l.shop_id and b.lot_id=l.id group by b.location having sum(b.delta)>0))
  group by l.id,p.id,s.id,x.location
  on conflict on constraint guigs_inventory_partition_key do nothing;
  get diagnostics v_added=row_count;
  return v_added;
end $$;

create or replace function public.guigs_get_inventory(p_shop_id uuid,p_inventory_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v public.guigs_inventories; v_items jsonb; v_audit jsonb; v_new integer;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop_id and id=p_inventory_id;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if v.spatial then raise exception 'Use o inventário espacial da v1.7.'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.product_name,q.expiry,q.lot_id,q.location),'[]'::jsonb) into v_items from (
    select i.*, (select email from auth.users where id=i.counted_by) as counted_by_label,
      coalesce(sum(m.delta),0) as current_quantity,count(m.id) as current_movement_count,
      (count(m.id)<>i.basis_movement_count or coalesce(sum(m.delta),0)<>i.basis_quantity) as conflict
    from public.guigs_inventory_items i left join public.guigs_movements m
      on m.shop_id=i.shop_id and m.lot_id=i.lot_id and m.location=i.location
    where i.inventory_id=v.id group by i.id
  ) q;
  select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_label',(select email from auth.users where id=a.actor_id)) order by a.created_at,a.id),'[]'::jsonb) into v_audit from public.guigs_inventory_audit a where a.inventory_id=v.id;
  select count(*) into v_new from public.guigs_lots l join public.guigs_products p on p.id=l.product_id and p.shop_id=l.shop_id
    where l.shop_id=p_shop_id and (p.active or exists(select 1 from public.guigs_movements b where b.shop_id=l.shop_id and b.lot_id=l.id group by b.location having sum(b.delta)>0))
    and not exists(select 1 from public.guigs_inventory_items i where i.inventory_id=v.id and i.lot_id=l.id);
  return jsonb_build_object('inventory',to_jsonb(v)||jsonb_build_object('started_by_label',(select email from auth.users where id=v.started_by),'completed_by_label',(select email from auth.users where id=v.completed_by)),'items',v_items,'audit',v_audit,'new_lots',v_new,
    'movements_after_start',greatest(0,(select count(*) from public.guigs_movements where shop_id=p_shop_id)-v.start_movement_count));
end $$;

create function guigs_private.spatial_inventory_lock(p_shop uuid,p_inventory uuid,p_owner boolean)
returns public.guigs_inventories language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories;
begin
  if guigs_private.member_role(p_shop) is null then raise exception 'Acesso negado.'; end if;
  if p_owner and guigs_private.member_role(p_shop) is distinct from 'owner' then raise exception 'Apenas proprietários podem administrar inventário.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop and id=p_inventory for update;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if not v.spatial then raise exception 'Inventário não é espacial.'; end if;
  if v.status in ('completed','cancelled') then raise exception 'Inventário encerrado: somente leitura.'; end if;
  return v;
end $$;

revoke all on function guigs_private.spatial_inventory_lock(uuid,uuid,boolean) from public,anon,authenticated;

create function public.guigs_create_spatial_inventory(p_shop_id uuid,p_observation text default '')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_count bigint;
begin
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then raise exception 'Apenas proprietários podem criar inventário.'; end if;
  if length(coalesce(p_observation,''))>1000 then raise exception 'Observação excede 1000 caracteres.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para capturar o inventário.'; end if;
  -- Curto gate atômico de escopo: NOWAIT falha se houver operação em andamento.
  -- EXCLUSIVE conflita com INSERT/UPSERT e SELECT FOR UPDATE das RPCs legadas.
  lock table public.guigs_lots in exclusive mode nowait;
  select count(*) into v_count from public.guigs_movements where shop_id=p_shop_id;
  insert into public.guigs_inventories(shop_id,started_by,observation,start_movement_count,spatial)
    values(p_shop_id,auth.uid(),coalesce(p_observation,''),v_count,true) returning id into v_id;
  perform guigs_private.spatial_inventory_add_items(p_shop_id,v_id);
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id) values(p_shop_id,v_id,'created',auth.uid());
  return v_id;
exception when unique_violation then raise exception 'Já existe inventário aberto ou em revisão nesta loja.';
end $$;

create function public.guigs_get_spatial_inventory(p_shop_id uuid,p_inventory_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v public.guigs_inventories; v_items jsonb; v_audit jsonb; v_new integer;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop_id and id=p_inventory_id;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if not v.spatial then raise exception 'Inventário não é espacial.'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.product_name,q.expiry,q.lot_id,q.location,q.slot_label,q.slot_id),'[]'::jsonb) into v_items from (
    select i.*, (select email from auth.users where id=i.counted_by) as counted_by_label,
      coalesce(sum(m.delta),0) as current_quantity,count(m.id) as current_movement_count,
      (count(m.id)<>i.basis_movement_count or coalesce(sum(m.delta),0)<>i.basis_quantity) as conflict
    from public.guigs_inventory_items i left join public.guigs_movements m
      on m.shop_id=i.shop_id and m.lot_id=i.lot_id and m.location=i.location and m.slot_id is not distinct from i.slot_id
    where i.inventory_id=v.id group by i.id
  ) q;
  select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_label',(select email from auth.users where id=a.actor_id)) order by a.created_at,a.id),'[]'::jsonb) into v_audit from public.guigs_inventory_audit a where a.inventory_id=v.id;
  v_new:=case when v.status in ('open','review') then guigs_private.spatial_inventory_missing(p_shop_id,v.id) else 0 end;
  return jsonb_build_object('inventory',to_jsonb(v)||jsonb_build_object('started_by_label',(select email from auth.users where id=v.started_by),'completed_by_label',(select email from auth.users where id=v.completed_by)),'items',v_items,'audit',v_audit,'new_lots',v_new,
    'movements_after_start',greatest(0,(select count(*) from public.guigs_movements where shop_id=p_shop_id)-v.start_movement_count));
end $$;

create function public.guigs_count_spatial_inventory_item(p_shop_id uuid,p_inventory_id uuid,p_item_id uuid,p_quantity integer,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; i public.guigs_inventory_items;
begin
  v:=guigs_private.spatial_inventory_lock(p_shop_id,p_inventory_id,false);
  if v.status<>'open' then raise exception 'Reabra o inventário para contar.'; end if;
  if p_quantity is null or p_quantity<0 then raise exception 'Contagem inválida.'; end if;
  select * into i from public.guigs_inventory_items where shop_id=p_shop_id and inventory_id=v.id and id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  if p_version is distinct from i.version then raise exception 'Item alterado por outra pessoa. Atualize antes de salvar.'; end if;
  if i.counted_quantity is not null then raise exception 'Use Recontar para preservar a evidência anterior.'; end if;
  update public.guigs_inventory_items set counted_quantity=p_quantity,counted_by=auth.uid(),counted_at=clock_timestamp(),version=version+1 where id=i.id;
  update public.guigs_inventories set version=version+1 where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,item_id,action,actor_id,counted_quantity,basis_quantity)
    values(p_shop_id,v.id,i.id,'counted',auth.uid(),p_quantity,i.basis_quantity);
  return true;
end $$;

create function public.guigs_recount_spatial_inventory_item(p_shop_id uuid,p_inventory_id uuid,p_item_id uuid,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; i public.guigs_inventory_items; v_qty bigint; v_count bigint;
begin
  v:=guigs_private.spatial_inventory_lock(p_shop_id,p_inventory_id,false);
  if v.status<>'open' then raise exception 'Reabra o inventário para recontar.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para recontar.'; end if;
  select * into i from public.guigs_inventory_items where shop_id=p_shop_id and inventory_id=v.id and id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  if p_version is distinct from i.version then raise exception 'Item alterado por outra pessoa. Atualize antes de recontar.'; end if;
  perform 1 from public.guigs_lots where shop_id=p_shop_id and id=i.lot_id for update;
  select coalesce(sum(delta),0),count(*) into v_qty,v_count from public.guigs_movements where shop_id=p_shop_id and lot_id=i.lot_id and location=i.location and slot_id is not distinct from i.slot_id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,item_id,action,actor_id,previous_quantity,basis_quantity)
    values(p_shop_id,v.id,i.id,'recount',auth.uid(),i.counted_quantity,v_qty);
  update public.guigs_inventory_items set counted_quantity=null,counted_by=null,counted_at=null,
    basis_quantity=v_qty,basis_movement_count=v_count,version=version+1 where id=i.id;
  update public.guigs_inventories set version=version+1 where id=v.id;
  return true;
end $$;

create function public.guigs_refresh_spatial_inventory_scope(p_shop_id uuid,p_inventory_id uuid,p_version integer)
returns integer language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; v_added integer;
begin
  v:=guigs_private.spatial_inventory_lock(p_shop_id,p_inventory_id,true);
  if v.status<>'open' or p_version is distinct from v.version then raise exception 'Atualize e abra o inventário antes de incluir lotes.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para incluir lotes.'; end if;
  lock table public.guigs_lots in exclusive mode nowait;
  v_added:=guigs_private.spatial_inventory_add_items(p_shop_id,v.id);
  update public.guigs_inventories set version=version+1 where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id,note) values(p_shop_id,v.id,'scope_refreshed',auth.uid(),'Itens novos: '||v_added);
  return v_added;
end $$;

create function public.guigs_set_spatial_inventory_status(p_shop_id uuid,p_inventory_id uuid,p_status text,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories;
begin
  v:=guigs_private.spatial_inventory_lock(p_shop_id,p_inventory_id,true);
  if p_version is distinct from v.version then raise exception 'Inventário alterado. Atualize antes de continuar.'; end if;
  if p_status is null or not ((v.status='open' and p_status='review') or (v.status='review' and p_status='open') or p_status='cancelled') then
    raise exception 'Transição de inventário inválida.';
  end if;
  update public.guigs_inventories set status=p_status,version=version+1,
    cancelled_at=case when p_status='cancelled' then clock_timestamp() else null end,
    cancelled_by=case when p_status='cancelled' then auth.uid() else null end where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id)
    values(p_shop_id,v.id,case p_status when 'open' then 'reopened' when 'review' then 'review' else 'cancelled' end,auth.uid());
  return true;
end $$;

create function public.guigs_complete_spatial_inventory(p_shop_id uuid,p_inventory_id uuid,p_version integer,p_confirm boolean,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; item public.guigs_inventory_items; cached jsonb;
  adjusted integer:=0; diff integer; adjustment uuid;
begin
  if auth.uid() is null or guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Apenas proprietários podem fechar inventário.';
  end if;
  if p_confirm is distinct from true then raise exception 'Revise e confirme explicitamente o fechamento.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop_id and id=p_inventory_id and spatial for update;
  if not found then raise exception 'Inventário espacial não encontrado.'; end if;
  perform guigs_private.spatial_stock_gate();
  cached:=guigs_private.begin_spatial_command(p_shop_id,p_request_id,'complete-inventory',
    jsonb_build_object('inventory',p_inventory_id,'version',p_version));
  if cached is not null then return cached; end if;
  if v.status<>'review' or p_version is distinct from v.version then
    raise exception 'Revisão desatualizada ou inventário encerrado. Atualize.';
  end if;
  if guigs_private.spatial_inventory_missing(p_shop_id,v.id)>0 then
    raise exception 'Há partições novas. Reabra e inclua o novo escopo antes de finalizar.';
  end if;
  if not exists(select 1 from public.guigs_inventory_items where inventory_id=v.id) then raise exception 'Inventário sem itens.'; end if;
  if exists(select 1 from public.guigs_inventory_items where inventory_id=v.id and counted_quantity is null) then
    raise exception 'Existem itens não contados.';
  end if;
  if exists(
    with balances as materialized (
      select m.lot_id,m.location,m.slot_id,count(*) as events,sum(m.delta) as quantity
      from public.guigs_movements m where m.shop_id=p_shop_id group by m.lot_id,m.location,m.slot_id
    )
    select 1 from public.guigs_inventory_items i left join balances b
      on b.lot_id=i.lot_id and b.location=i.location and b.slot_id is not distinct from i.slot_id
    where i.shop_id=p_shop_id and i.inventory_id=v.id
      and (i.basis_movement_count<>coalesce(b.events,0) or i.basis_quantity<>coalesce(b.quantity,0))
  ) then raise exception 'Movimentações posteriores: reabra e reconte as posições afetadas.'; end if;
  -- Primeiro reduções: troca de lote em slot cheio não excede a capacidade no meio da transação.
  for item in select * from public.guigs_inventory_items where inventory_id=v.id
    order by counted_quantity-basis_quantity,lot_id,location,slot_id loop
    diff:=item.counted_quantity-item.basis_quantity;
    adjustment:=null;
    if diff<>0 then
      adjustment:=gen_random_uuid();
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
        values(p_shop_id,item.lot_id,adjustment,'adjust',item.location,diff,auth.uid(),'Ajuste por inventário espacial #'||v.id,item.slot_id,true);
      adjusted:=adjusted+1;
    end if;
    update public.guigs_inventory_items set applied_delta=diff,adjustment_event_id=adjustment where id=item.id;
  end loop;
  update public.guigs_inventories set status='completed',completed_at=clock_timestamp(),completed_by=auth.uid(),version=version+1 where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id,note) values(p_shop_id,v.id,'completed',auth.uid(),'Ajustes: '||adjusted);
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,jsonb_build_object('inventory_id',v.id,'adjustments',adjusted));
end $$;

revoke all on function public.guigs_create_spatial_inventory(uuid,text),public.guigs_get_spatial_inventory(uuid,uuid),
  public.guigs_count_spatial_inventory_item(uuid,uuid,uuid,integer,integer),public.guigs_recount_spatial_inventory_item(uuid,uuid,uuid,integer),
  public.guigs_refresh_spatial_inventory_scope(uuid,uuid,integer),public.guigs_set_spatial_inventory_status(uuid,uuid,text,integer),
  public.guigs_complete_spatial_inventory(uuid,uuid,integer,boolean,uuid) from public,anon,authenticated;
grant execute on function public.guigs_create_spatial_inventory(uuid,text),public.guigs_get_spatial_inventory(uuid,uuid),
  public.guigs_count_spatial_inventory_item(uuid,uuid,uuid,integer,integer),public.guigs_recount_spatial_inventory_item(uuid,uuid,uuid,integer),
  public.guigs_refresh_spatial_inventory_scope(uuid,uuid,integer),public.guigs_set_spatial_inventory_status(uuid,uuid,text,integer),
  public.guigs_complete_spatial_inventory(uuid,uuid,integer,boolean,uuid) to authenticated;
commit;
