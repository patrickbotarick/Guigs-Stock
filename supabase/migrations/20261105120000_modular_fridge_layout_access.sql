-- O papel continua owner/attendant. A delegação concede apenas edição estrutural.
begin;
set local lock_timeout='5s';

alter table public.guigs_memberships
  add column manage_fridge_layout boolean not null default false;

create function guigs_private.can_manage_fridge_layout(p_shop uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.guigs_memberships m
    where m.shop_id=p_shop and m.user_id=(select auth.uid()) and m.active
      and (m.role='owner' or m.manage_fridge_layout));
$$;
revoke all on function guigs_private.can_manage_fridge_layout(uuid) from public,anon,authenticated;
grant execute on function guigs_private.can_manage_fridge_layout(uuid) to authenticated;

create function public.guigs_list_fridge_layout_access(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Somente proprietários podem administrar esta permissão.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',u.email,
    'manage_fridge_layout',m.manage_fridge_layout) order by u.email,m.user_id)
    from public.guigs_memberships m join auth.users u on u.id=m.user_id
    where m.shop_id=p_shop_id and m.role='attendant' and m.active),'[]'::jsonb);
end $$;
revoke all on function public.guigs_list_fridge_layout_access(uuid) from public,anon,authenticated;
grant execute on function public.guigs_list_fridge_layout_access(uuid) to authenticated;

create function public.guigs_set_fridge_layout_access(p_shop_id uuid,p_user_id uuid,p_allowed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform guigs_private.spatial_stock_gate();
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Somente proprietários podem administrar esta permissão.';
  end if;
  if p_allowed is null then raise exception 'Informe a permissão.'; end if;
  update public.guigs_memberships set manage_fridge_layout=p_allowed
    where shop_id=p_shop_id and user_id=p_user_id and role='attendant' and active;
  if not found then raise exception 'Atendente ativo indisponível nesta loja.'; end if;
  return jsonb_build_object('user_id',p_user_id,'manage_fridge_layout',p_allowed);
end $$;
revoke all on function public.guigs_set_fridge_layout_access(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.guigs_set_fridge_layout_access(uuid,uuid,boolean) to authenticated;

create or replace function public.guigs_save_fridge_layout(p_shop_id uuid,p_kind text,p_values jsonb,p_id uuid default null,p_revision integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_name text; v_active boolean; v_order integer; v_fridge uuid; v_shelf uuid; v_product uuid;
  v_width numeric; v_start numeric; v_height numeric; v_min integer; v_target integer; v_capacity integer;
  v_result jsonb; v_current_product uuid; v_current_fridge uuid; v_current_shelf uuid;
begin
  perform guigs_private.spatial_stock_gate();
  if not guigs_private.can_manage_fridge_layout(p_shop_id) then
    raise exception 'Sem permissão para configurar geladeiras.';
  end if;
  if p_kind is null or p_kind not in ('fridge','shelf','slot') or jsonb_typeof(p_values) is distinct from 'object'
     or ((p_id is null) <> (p_revision is null)) then raise exception 'Layout inválido.'; end if;
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
    if p_values->>'capacity_quantity' is not null
       and (p_values->>'capacity_quantity') !~ '^[1-9][0-9]{0,6}$' then
      raise exception 'Informe uma capacidade inteira positiva ou deixe em branco.';
    end if;
    v_capacity:=(p_values->>'capacity_quantity')::integer;
    if v_capacity>1000000 then raise exception 'A capacidade máxima é de 1000000 unidades.'; end if;
    if p_id is not null then
      select x.product_id,x.fridge_id,x.shelf_id into v_current_product,v_current_fridge,v_current_shelf from public.guigs_fridge_slots x where x.shop_id=p_shop_id and x.id=p_id and x.revision=p_revision;
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
        group by m.lot_id,l.product_id having sum(m.delta)<>0 and (not v_active or l.product_id is distinct from v_product or v_current_fridge is distinct from v_fridge or v_current_shelf is distinct from v_shelf))
        or (select coalesce(sum(delta),0) from public.guigs_movements where shop_id=p_shop_id and slot_id=p_id)>coalesce(v_capacity,0) then
        raise exception 'Posição com saldo incompatível. Realocar estoque antes de alterar.';
      end if;
      update public.guigs_fridge_slots x set fridge_id=v_fridge,shelf_id=v_shelf,product_id=v_product,name=v_name,active=v_active,sort_order=v_order,
        x_ratio=v_start,width_ratio=v_width,min_quantity=v_min,target_quantity=v_target,capacity_quantity=v_capacity,revision=x.revision+1
        where x.shop_id=p_shop_id and x.id=p_id and x.revision=p_revision returning to_jsonb(x) into v_result;
    end if;
  end if;
  if v_result is null then raise exception 'Layout alterado ou indisponível. Atualize o mapa.'; end if;
  return v_result;
end $$;

create or replace function public.guigs_get_fridge_map(p_shop_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  with activated_slots as materialized (
    select distinct m.slot_id,l.product_id
    from public.guigs_movements m join public.guigs_lots l
      on (l.shop_id,l.id)=(m.shop_id,m.lot_id)
    where m.shop_id=p_shop_id and m.slot_id is not null
  ), balances as materialized (
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
    'can_manage_layout',guigs_private.can_manage_fridge_layout(p_shop_id),
    'fridges',coalesce((select jsonb_agg(to_jsonb(f) order by f.sort_order,f.id)
      from public.guigs_fridges f where f.shop_id=p_shop_id),'[]'::jsonb),
    'shelves',coalesce((select jsonb_agg(to_jsonb(h) order by h.sort_order,h.id)
      from public.guigs_fridge_shelves h where h.shop_id=p_shop_id),'[]'::jsonb),
    'slots',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('quantity',coalesce(s.quantity,0),
      'is_activated',exists(select 1 from activated_slots a where a.slot_id=x.id and a.product_id=x.product_id),
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
    if s.capacity_quantity is null then
      raise exception 'Defina a capacidade do slot antes de alocar estoque.';
    end if;
    if s.product_id is null then
      raise exception 'Defina o produto do slot antes de alocar estoque.';
    end if;
    if s.product_id is distinct from v_product then
      raise exception 'Produto incompatível com a posição.';
    end if;
    select coalesce(sum(m.delta),0) into v_slot_balance from public.guigs_movements m
      where m.shop_id=new.shop_id and m.slot_id=new.slot_id;
    if v_slot_balance+new.delta>s.capacity_quantity then raise exception 'Capacidade da posição excedida.'; end if;
  end if;
  new.slot_label:=s.label;
  return new;
end $$;

create or replace function public.guigs_allocate_fridge_stock(p_shop_id uuid,p_request_id uuid,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cached jsonb; e record; v_total bigint:=0; v_event uuid:=gen_random_uuid();
begin
  if auth.uid() is null or guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Somente proprietários podem distribuir estoque existente.';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'Distribuição inválida.'; end if;
  if jsonb_array_length(p_entries) not between 1 and 100 then raise exception 'Informe de 1 a 100 destinos.'; end if;
  perform guigs_private.spatial_stock_gate();
  cached:=guigs_private.begin_spatial_command(p_shop_id,p_request_id,'allocate',p_entries);
  if cached is not null then return cached; end if;
  if exists(select 1 from jsonb_to_recordset(p_entries) as x(lot_id uuid,slot_id uuid,quantity integer)
    group by x.lot_id,x.slot_id having count(*)>1) then raise exception 'Destino repetido para o mesmo lote.'; end if;
  for e in select * from jsonb_to_recordset(p_entries) as x(lot_id uuid,slot_id uuid,quantity integer) order by x.lot_id,x.slot_id loop
    if e.lot_id is null or e.slot_id is null or e.quantity is null or e.quantity not between 1 and 1000000 then
      raise exception 'Informe lote, posição e quantidade positiva.';
    end if;
    if not exists(select 1 from public.guigs_lots where shop_id=p_shop_id and id=e.lot_id)
       or not exists(select 1 from public.guigs_fridge_slots where shop_id=p_shop_id and id=e.slot_id) then
      raise exception 'Lote ou posição indisponível nesta loja.';
    end if;
    if exists(select 1 from public.guigs_fridge_slots
      where shop_id=p_shop_id and id=e.slot_id and capacity_quantity is null) then
      raise exception 'Defina a capacidade do slot antes de alocar estoque.';
    end if;
    if exists(select 1 from public.guigs_fridge_slots
      where shop_id=p_shop_id and id=e.slot_id and product_id is null) then
      raise exception 'Defina o produto do slot antes de alocar estoque.';
    end if;
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
      values(p_shop_id,e.lot_id,v_event,'relocate','fridge',-e.quantity,auth.uid(),'Distribuição de estoque existente',null,true),
            (p_shop_id,e.lot_id,v_event,'relocate','fridge',e.quantity,auth.uid(),'Distribuição de estoque existente',e.slot_id,true);
    v_total:=v_total+e.quantity;
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,jsonb_build_object('event_id',v_event,'quantity',v_total));
end $$;

commit;
