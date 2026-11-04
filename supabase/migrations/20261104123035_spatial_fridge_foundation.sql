-- v1.7B. Apply only to the verified test project during development.
begin;
set local lock_timeout = '5s';

create table public.guigs_fridges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.guigs_shops(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 10000),
  width_ratio numeric(5,4) not null default 1 check (width_ratio between 0.25 and 1),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  unique(shop_id,id)
);
create table public.guigs_fridge_shelves (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  fridge_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 10000),
  y_ratio numeric(5,4) not null default 0 check (y_ratio >= 0),
  height_ratio numeric(5,4) not null default 1 check (height_ratio >= 0.05 and y_ratio+height_ratio<=1),
  revision integer not null default 1,
  unique(shop_id,fridge_id,id),
  foreign key(shop_id,fridge_id) references public.guigs_fridges(shop_id,id)
);
create table public.guigs_fridge_slots (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  fridge_id uuid not null,
  shelf_id uuid not null,
  product_id uuid,
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 10000),
  x_ratio numeric(5,4) not null default 0 check (x_ratio >= 0),
  width_ratio numeric(5,4) not null default 1 check (width_ratio >= 0.05 and x_ratio+width_ratio<=1),
  min_quantity integer not null default 0,
  target_quantity integer not null default 0,
  capacity_quantity integer not null default 24,
  revision integer not null default 1,
  check (min_quantity>=0 and min_quantity<=target_quantity and target_quantity<=capacity_quantity
    and capacity_quantity between 1 and 1000000),
  unique(shop_id,id),
  foreign key(shop_id,fridge_id,shelf_id) references public.guigs_fridge_shelves(shop_id,fridge_id,id),
  foreign key(shop_id,product_id) references public.guigs_products(shop_id,id)
);
create index guigs_fridge_slots_shelf_idx on public.guigs_fridge_slots(shop_id,fridge_id,shelf_id);
create index guigs_fridge_slots_product_idx on public.guigs_fridge_slots(shop_id,product_id) where product_id is not null;

alter table public.guigs_products add column image_path text
  check (image_path is null or (length(image_path)<=240 and image_path like shop_id::text||'/'||id::text||'/%'));
alter table public.guigs_movements
  add column slot_id uuid,
  add column slot_label text check (length(slot_label)<=400),
  add column spatial boolean not null default false,
  add constraint guigs_movements_slot_location check (slot_id is null or (location='fridge' and spatial)),
  add constraint guigs_movements_slot_fk foreign key(shop_id,slot_id) references public.guigs_fridge_slots(shop_id,id);
create index guigs_movements_slot_idx on public.guigs_movements(shop_id,slot_id,lot_id) include(delta) where slot_id is not null;
create index guigs_movements_fridge_lot_slot_idx on public.guigs_movements(shop_id,lot_id,slot_id) include(delta) where location='fridge';

alter table public.guigs_fridges enable row level security;
alter table public.guigs_fridge_shelves enable row level security;
alter table public.guigs_fridge_slots enable row level security;
create policy guigs_fridges_read on public.guigs_fridges for select to authenticated using (guigs_private.is_member(shop_id));
create policy guigs_fridge_shelves_read on public.guigs_fridge_shelves for select to authenticated using (guigs_private.is_member(shop_id));
create policy guigs_fridge_slots_read on public.guigs_fridge_slots for select to authenticated using (guigs_private.is_member(shop_id));
revoke all on public.guigs_fridges,public.guigs_fridge_shelves,public.guigs_fridge_slots from public,anon,authenticated;
grant select on public.guigs_fridges,public.guigs_fridge_shelves,public.guigs_fridge_slots to authenticated;

create function guigs_private.spatial_stock_gate() returns void
language plpgsql set search_path='' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Use READ COMMITTED para operações espaciais.';
  end if;
  lock table public.guigs_lots in exclusive mode nowait;
end $$;
revoke all on function guigs_private.spatial_stock_gate() from public,anon,authenticated;

create function guigs_private.spatial_ledger_guard() returns trigger
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
  if exists(select 1 from public.guigs_inventories i where i.shop_id=new.shop_id and i.status in ('open','review')) then
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
revoke all on function guigs_private.spatial_ledger_guard() from public,anon,authenticated;
create trigger guigs_spatial_ledger_guard before insert on public.guigs_movements
  for each row execute function guigs_private.spatial_ledger_guard();

create function guigs_private.reject_legacy_inventory_with_slots() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from public.guigs_movements m where m.shop_id=new.shop_id and m.slot_id is not null
      group by m.slot_id,m.lot_id having sum(m.delta)>0) then
    raise exception 'Há estoque em posições físicas. Use o inventário espacial.';
  end if;
  return new;
end $$;
revoke all on function guigs_private.reject_legacy_inventory_with_slots() from public,anon,authenticated;
create trigger guigs_legacy_inventory_guard before insert on public.guigs_inventories
  for each row execute function guigs_private.reject_legacy_inventory_with_slots();

create function public.guigs_get_fridge_map(p_shop_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  with balances as materialized (
    select m.slot_id,m.lot_id,m.location,sum(m.delta) as quantity
    from public.guigs_movements m where m.shop_id=p_shop_id
    group by m.slot_id,m.lot_id,m.location having sum(m.delta)<>0
  ), lot_rows as materialized (
    select b.*,l.code,l.expiry,l.created_at as lot_created_at,l.product_id,p.name as product_name,p.active as product_active,p.image_path
    from balances b join public.guigs_lots l on l.shop_id=p_shop_id and l.id=b.lot_id
    join public.guigs_products p on p.shop_id=l.shop_id and p.id=l.product_id
  ), per_slot as (
    select l.slot_id,sum(l.quantity) as quantity,
      jsonb_agg(to_jsonb(l)-'slot_id'-'location' order by l.expiry,l.lot_created_at,l.lot_id) as lots
    from lot_rows l where l.slot_id is not null group by l.slot_id
  )
  select jsonb_build_object(
    'fridges',coalesce((select jsonb_agg(to_jsonb(f) order by f.sort_order,f.id)
      from public.guigs_fridges f where f.shop_id=p_shop_id),'[]'::jsonb),
    'shelves',coalesce((select jsonb_agg(to_jsonb(h) order by h.sort_order,h.id)
      from public.guigs_fridge_shelves h where h.shop_id=p_shop_id),'[]'::jsonb),
    'slots',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('quantity',coalesce(s.quantity,0),
      'lots',coalesce(s.lots,'[]'::jsonb),'product_name',p.name,'product_active',p.active,'image_path',p.image_path)
      order by x.sort_order,x.id) from public.guigs_fridge_slots x
      left join per_slot s on s.slot_id=x.id
      left join public.guigs_products p on p.shop_id=x.shop_id and p.id=x.product_id
      where x.shop_id=p_shop_id),'[]'::jsonb),
    'unallocated',coalesce((select jsonb_agg(to_jsonb(l)-'slot_id'-'location' order by l.expiry,l.lot_created_at,l.lot_id)
      from lot_rows l where l.location='fridge' and l.slot_id is null),'[]'::jsonb),
    'dry',coalesce((select jsonb_agg(to_jsonb(l)-'slot_id'-'location' order by l.expiry,l.lot_created_at,l.lot_id)
      from lot_rows l where l.location='stock'),'[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.guigs_get_fridge_map(uuid) from public,anon,authenticated;
grant execute on function public.guigs_get_fridge_map(uuid) to authenticated;

-- Single owner-only command. Parent IDs are immutable after creation; stale edits are rejected.
create function public.guigs_save_fridge_layout(p_shop_id uuid,p_kind text,p_values jsonb,p_id uuid default null,p_revision integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_name text; v_active boolean; v_order integer; v_fridge uuid; v_shelf uuid; v_product uuid;
  v_width numeric; v_start numeric; v_height numeric; v_min integer; v_target integer; v_capacity integer;
  v_result jsonb; v_current_product uuid;
begin
  if auth.uid() is null or guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Somente proprietários podem configurar geladeiras.';
  end if;
  if p_kind is null or p_kind not in ('fridge','shelf','slot') or jsonb_typeof(p_values) is distinct from 'object'
     or ((p_id is null) <> (p_revision is null)) then raise exception 'Layout inválido.'; end if;
  perform guigs_private.spatial_stock_gate();
  v_name:=btrim(p_values->>'name');
  v_active:=coalesce((p_values->>'active')::boolean,true);
  v_order:=coalesce((p_values->>'sort_order')::integer,0);
  if p_kind='fridge' then
    v_width:=coalesce((p_values->>'width_ratio')::numeric,1);
    if p_id is null then
      insert into public.guigs_fridges as f(shop_id,name,active,sort_order,width_ratio)
        values(p_shop_id,v_name,v_active,v_order,v_width) returning to_jsonb(f) into v_result;
    else
      if not v_active and exists(select 1 from public.guigs_movements m join public.guigs_fridge_slots x
        on (x.shop_id,x.id)=(m.shop_id,m.slot_id) where m.shop_id=p_shop_id and x.fridge_id=p_id
        group by m.slot_id,m.lot_id having sum(m.delta)<>0) then raise exception 'Geladeira com saldo: realoque antes de desativar.'; end if;
      update public.guigs_fridges f set name=v_name,active=v_active,sort_order=v_order,width_ratio=v_width,revision=f.revision+1
        where f.shop_id=p_shop_id and f.id=p_id and f.revision=p_revision returning to_jsonb(f) into v_result;
    end if;
  elsif p_kind='shelf' then
    v_fridge:=(p_values->>'fridge_id')::uuid;
    v_start:=coalesce((p_values->>'y_ratio')::numeric,0);
    v_height:=coalesce((p_values->>'height_ratio')::numeric,1);
    if p_id is null then
      insert into public.guigs_fridge_shelves as h(shop_id,fridge_id,name,active,sort_order,y_ratio,height_ratio)
        values(p_shop_id,v_fridge,v_name,v_active,v_order,v_start,v_height) returning to_jsonb(h) into v_result;
    else
      if not v_active and exists(select 1 from public.guigs_movements m join public.guigs_fridge_slots x
        on (x.shop_id,x.id)=(m.shop_id,m.slot_id) where m.shop_id=p_shop_id and x.shelf_id=p_id
        group by m.slot_id,m.lot_id having sum(m.delta)<>0) then raise exception 'Prateleira com saldo: realoque antes de desativar.'; end if;
      update public.guigs_fridge_shelves h set name=v_name,active=v_active,sort_order=v_order,y_ratio=v_start,
        height_ratio=v_height,revision=h.revision+1 where h.shop_id=p_shop_id and h.id=p_id and h.revision=p_revision
        returning to_jsonb(h) into v_result;
    end if;
  else
    v_fridge:=(p_values->>'fridge_id')::uuid; v_shelf:=(p_values->>'shelf_id')::uuid;
    v_product:=(p_values->>'product_id')::uuid; v_start:=coalesce((p_values->>'x_ratio')::numeric,0);
    v_width:=coalesce((p_values->>'width_ratio')::numeric,1);
    v_min:=coalesce((p_values->>'min_quantity')::integer,0); v_target:=coalesce((p_values->>'target_quantity')::integer,0);
    v_capacity:=coalesce((p_values->>'capacity_quantity')::integer,24);
    if p_id is not null then
      select x.product_id into v_current_product from public.guigs_fridge_slots x where x.shop_id=p_shop_id and x.id=p_id and x.revision=p_revision;
      if not found then raise exception 'Layout alterado ou indisponível. Atualize o mapa.'; end if;
    end if;
    if v_product is not null and not exists(select 1 from public.guigs_products p
      where p.shop_id=p_shop_id and p.id=v_product and (p.active or p.id=v_current_product)) then
      raise exception 'Produto indisponível nesta loja.';
    end if;
    if p_id is null then
      insert into public.guigs_fridge_slots as x(shop_id,fridge_id,shelf_id,product_id,name,active,sort_order,
        x_ratio,width_ratio,min_quantity,target_quantity,capacity_quantity)
        values(p_shop_id,v_fridge,v_shelf,v_product,v_name,v_active,v_order,v_start,v_width,v_min,v_target,v_capacity)
        returning to_jsonb(x) into v_result;
    else
      if exists(select 1 from public.guigs_movements m join public.guigs_lots l
        on (l.shop_id,l.id)=(m.shop_id,m.lot_id) where m.shop_id=p_shop_id and m.slot_id=p_id
        group by m.lot_id,l.product_id having sum(m.delta)<>0 and (not v_active or (v_product is not null and l.product_id<>v_product)))
        or (select coalesce(sum(delta),0) from public.guigs_movements where shop_id=p_shop_id and slot_id=p_id)>v_capacity then
        raise exception 'Posição com saldo incompatível. Realocar estoque antes de alterar.';
      end if;
      update public.guigs_fridge_slots x set product_id=v_product,name=v_name,active=v_active,sort_order=v_order,
        x_ratio=v_start,width_ratio=v_width,min_quantity=v_min,target_quantity=v_target,capacity_quantity=v_capacity,revision=x.revision+1
        where x.shop_id=p_shop_id and x.id=p_id and x.revision=p_revision returning to_jsonb(x) into v_result;
    end if;
  end if;
  if v_result is null then raise exception 'Layout alterado ou indisponível. Atualize o mapa.'; end if;
  return v_result;
end $$;
revoke all on function public.guigs_save_fridge_layout(uuid,text,jsonb,uuid,integer) from public,anon,authenticated;
grant execute on function public.guigs_save_fridge_layout(uuid,text,jsonb,uuid,integer) to authenticated;
commit;
