-- Posições visuais podem aguardar medição. O ledger continua bloqueado para entradas.
begin;
set local lock_timeout='5s';

-- O CHECK existente continua exigindo capacidade positiva e limitando a meta
-- quando a capacidade está definida. Os valores existentes são preservados.
alter table public.guigs_fridge_slots
  alter column capacity_quantity drop not null,
  alter column capacity_quantity drop default;

create or replace function public.guigs_save_fridge_layout(p_shop_id uuid,p_kind text,p_values jsonb,p_id uuid default null,p_revision integer default null)
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
    if p_values->>'capacity_quantity' is not null
       and (p_values->>'capacity_quantity') !~ '^[1-9][0-9]{0,6}$' then
      raise exception 'Informe uma capacidade inteira positiva ou deixe em branco.';
    end if;
    v_capacity:=(p_values->>'capacity_quantity')::integer;
    if v_capacity>1000000 then raise exception 'A capacidade máxima é de 1000000 unidades.'; end if;
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
        or (select coalesce(sum(delta),0) from public.guigs_movements where shop_id=p_shop_id and slot_id=p_id)>coalesce(v_capacity,0) then
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
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
      values(p_shop_id,e.lot_id,v_event,'relocate','fridge',-e.quantity,auth.uid(),'Distribuição de estoque existente',null,true),
            (p_shop_id,e.lot_id,v_event,'relocate','fridge',e.quantity,auth.uid(),'Distribuição de estoque existente',e.slot_id,true);
    v_total:=v_total+e.quantity;
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,jsonb_build_object('event_id',v_event,'quantity',v_total));
end $$;

create or replace function public.guigs_get_fridge_replenishment(p_shop_id uuid,p_slot_id uuid,p_quantity integer default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare s record; current_units bigint; available bigint; expired bigint; deficit bigint; units bigint; plan jsonb;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_quantity is not null and p_quantity not between 1 and 1000000 then raise exception 'Quantidade inválida.'; end if;
  select x.*,p.name as product_name,p.active as product_active,h.active and f.active as parents_active into s
  from public.guigs_fridge_slots x join public.guigs_fridge_shelves h
    on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
  join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
  left join public.guigs_products p on (p.shop_id,p.id)=(x.shop_id,x.product_id)
  where x.shop_id=p_shop_id and x.id=p_slot_id;
  if not found or not s.active or not s.parents_active or s.product_active is distinct from true then
    raise exception 'Posição ou produto associado indisponível para reposição.';
  end if;
  if s.capacity_quantity is null then
    raise exception 'Defina a capacidade do slot antes de repor estoque.';
  end if;
  select coalesce(sum(m.delta),0) into current_units from public.guigs_movements m
    where m.shop_id=p_shop_id and m.slot_id=p_slot_id;
  deficit:=greatest(0,least(s.target_quantity,s.capacity_quantity)-current_units);
  with candidates as materialized (
    select * from guigs_private.dry_fefo(p_shop_id,s.product_id)
  ), available_totals as (
    select coalesce(sum(d.stock) filter(where d.expiry>=current_date),0) as available,
      coalesce(sum(d.stock) filter(where d.expiry<current_date),0) as expired
    from candidates d
  ), eligible as (
    select d.*,coalesce(sum(d.stock) over(order by d.expiry,d.created_at,d.lot_id
      rows between unbounded preceding and 1 preceding),0) as earlier
    from candidates d where d.expiry>=current_date
  ), selection as (
    select d.lot_id,d.code,d.expiry,d.created_at,least(d.stock,least(deficit,t.available,coalesce(p_quantity,1000000))-d.earlier)::integer as quantity
    from eligible d cross join available_totals t
    where d.earlier<least(deficit,t.available,coalesce(p_quantity,1000000))
    order by d.expiry,d.created_at,d.lot_id
  )
  select t.available,t.expired,least(deficit,t.available,coalesce(p_quantity,1000000)),
    coalesce((select jsonb_agg(to_jsonb(x)-'created_at' order by x.expiry,x.created_at,x.lot_id) from selection x),'[]'::jsonb)
  into available,expired,units,plan from available_totals t;
  return jsonb_build_object('slot_id',p_slot_id,'product_id',s.product_id,'product_name',s.product_name,
    'current',current_units,'capacity',s.capacity_quantity,'min',s.min_quantity,'target',s.target_quantity,
    'dry_available',available,'expired_dry',expired,'deficit',deficit,'quantity',units,'plan',plan);
end $$;

create or replace function public.guigs_get_fridge_operation(p_shop_id uuid,p_spec jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare op text:=p_spec->>'kind'; origin text:=p_spec->>'origin';
  product uuid:=(p_spec->>'product_id')::uuid; slot uuid:=(p_spec->>'slot_id')::uuid; lot uuid:=(p_spec->>'lot_id')::uuid;
  qty integer:=(p_spec->>'quantity')::integer; plan jsonb; amount bigint; current_units bigint; change integer;
  pos record; batch record; position_label text:='Geladeira — não alocado';
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if op is null or op not in ('sale','loss','return','adjust') or origin is null or origin not in ('auto','slot','unallocated')
     or (origin='slot')<>(slot is not null) or (op<>'sale' and (origin='auto' or lot is null))
     or qty is null or qty not between (case when op='adjust' then 0 else 1 end) and 1000000 then
    raise exception 'Operação, origem, lote ou quantidade inválida.';
  end if;
  if op='adjust' and not exists(select 1 from public.guigs_memberships m
    where m.shop_id=p_shop_id and m.user_id=(select auth.uid()) and m.role='owner' and m.active)
    then raise exception 'Somente proprietários podem ajustar saldo.'; end if;
  if origin='slot' then
    select x.product_id,x.capacity_quantity,f.name||' / '||h.name||' / '||x.name as label into pos
    from public.guigs_fridge_slots x join public.guigs_fridge_shelves h
      on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
    join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
    where x.shop_id=p_shop_id and x.id=slot and x.active and h.active and f.active;
    if not found then raise exception 'Posição indisponível.'; end if;
    if pos.capacity_quantity is null then
      raise exception 'Defina a capacidade do slot antes de movimentar estoque.';
    end if;
    position_label:=pos.label;
  end if;
  if op='sale' then
    if not exists(select 1 from public.guigs_products p where p.shop_id=p_shop_id and p.id=product and p.active) then
      raise exception 'Produto indisponível para venda.';
    end if;
    with qty_by_part as (
      select m.lot_id,m.slot_id,sum(m.delta)::bigint as units
      from public.guigs_lots l join public.guigs_movements m on (m.shop_id,m.lot_id)=(l.shop_id,l.id)
      where l.shop_id=p_shop_id and l.product_id=product and l.expiry>=current_date and m.location='fridge'
        and (lot is null or l.id=lot) and (origin='auto' or m.slot_id is not distinct from slot)
      group by m.lot_id,m.slot_id having sum(m.delta)>0
    ), ordered as (
      select b.*,l.code,l.expiry,l.created_at,
        case when b.slot_id is null then 'Geladeira — não alocado' else f.name||' / '||h.name||' / '||x.name end as slot_label,
        coalesce(f.sort_order,2147483647) as f_order,coalesce(h.sort_order,2147483647) as h_order,coalesce(x.sort_order,2147483647) as x_order
      from qty_by_part b join public.guigs_lots l on l.shop_id=p_shop_id and l.id=b.lot_id
      left join public.guigs_fridge_slots x on x.shop_id=p_shop_id and x.id=b.slot_id
      left join public.guigs_fridge_shelves h on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
      left join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
      where b.slot_id is null or (x.active and h.active and f.active)
    ), remaining as (
      select o.*,coalesce(sum(o.units) over(order by o.expiry,o.created_at,o.f_order,o.h_order,o.x_order,o.lot_id,o.slot_id
        rows between unbounded preceding and 1 preceding),0) as prior
      from ordered o
    )
    select coalesce(sum(least(r.units,qty-r.prior)),0),
      coalesce(jsonb_agg(jsonb_build_object('lot_id',r.lot_id,'slot_id',r.slot_id,'slot_label',r.slot_label,
        'code',r.code,'expiry',r.expiry,'current',r.units,'delta',-least(r.units,qty-r.prior))
        order by r.expiry,r.created_at,r.f_order,r.h_order,r.x_order,r.lot_id,r.slot_id),'[]'::jsonb)
    into amount,plan from remaining r where r.prior<qty;
    if amount<>qty then raise exception 'Saldo não vencido insuficiente na origem escolhida.'; end if;
  else
    select l.code,l.expiry,l.product_id into batch from public.guigs_lots l where l.shop_id=p_shop_id and l.id=lot;
    if not found or (product is not null and batch.product_id<>product) then raise exception 'Lote indisponível nesta loja.'; end if;
    select coalesce(sum(m.delta),0) into current_units from public.guigs_movements m
      where m.shop_id=p_shop_id and m.lot_id=lot and m.location='fridge' and m.slot_id is not distinct from slot;
    change:=case when op='adjust' then qty-current_units else -qty end;
    if change=0 then raise exception 'O saldo da posição já é a quantidade informada.'; end if;
    if current_units+change<0 then raise exception 'Saldo insuficiente na origem escolhida.'; end if;
    if change>0 and origin='slot' then
      if pos.product_id is not null and pos.product_id<>batch.product_id then raise exception 'Produto incompatível com a posição.'; end if;
      if change+(select coalesce(sum(m.delta),0) from public.guigs_movements m where m.shop_id=p_shop_id and m.slot_id=slot)>pos.capacity_quantity then
        raise exception 'Capacidade da posição excedida.';
      end if;
    end if;
    plan:=jsonb_build_array(jsonb_build_object('lot_id',lot,'slot_id',slot,'slot_label',position_label,
      'code',batch.code,'expiry',batch.expiry,'current',current_units,'delta',change));
  end if;
  return jsonb_build_object('kind',op,'quantity',qty,'plan',plan);
end $$;

create or replace function guigs_private.spatial_inventory_scope(p_shop uuid)
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
    where x.shop_id=p_shop and x.capacity_quantity is not null and x.active and h.active and f.active
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

commit;
