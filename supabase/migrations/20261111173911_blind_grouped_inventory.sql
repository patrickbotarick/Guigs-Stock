-- Contagem cega no contrato de leitura. Gravações e ledger preservados.

begin; set local lock_timeout='5s';

revoke select on public.guigs_inventory_items, public.guigs_inventory_audit from public,anon,authenticated;

create or replace function public.guigs_list_inventories(p_shop_id uuid,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'Página inválida.'; end if;
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into v_rows from (
    select v.*, (select email from auth.users where id=v.started_by) as started_by_label,
      (select email from auth.users where id=v.completed_by) as completed_by_label,
      (select count(*) from public.guigs_inventory_items i where i.inventory_id=v.id) as item_count,
      (select count(*) from public.guigs_inventory_items i where i.inventory_id=v.id and i.counted_quantity is not null) as counted_count,
      case when v.status<>'open' then (select count(*) from public.guigs_inventory_items i where i.inventory_id=v.id and i.counted_quantity<>i.basis_quantity) end as divergent_count
    from public.guigs_inventories v where v.shop_id=p_shop_id order by v.started_at desc,v.id limit p_limit offset p_offset
  ) q;
  return jsonb_build_object('inventories',v_rows,'total',(select count(*) from public.guigs_inventories where shop_id=p_shop_id),
    'last_completed',(select to_jsonb(c)||jsonb_build_object('completed_by_label',(select email from auth.users where id=c.completed_by)) from public.guigs_inventories c where c.shop_id=p_shop_id and c.status='completed' order by c.completed_at desc,c.id limit 1));
end $$;

create or replace function public.guigs_get_inventory(p_shop_id uuid,p_inventory_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v public.guigs_inventories; v_items jsonb; v_audit jsonb; v_new integer;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop_id and id=p_inventory_id;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if v.spatial then raise exception 'Use o inventário espacial da v1.7.'; end if;
  select coalesce(jsonb_agg((case when v.status='open' then to_jsonb(q)-array['expected_initial','basis_quantity','current_quantity','initial_movement_count','basis_movement_count','current_movement_count','applied_delta'] else to_jsonb(q) end) order by q.product_name,q.expiry,q.lot_id,q.location),'[]'::jsonb) into v_items from (
    select i.*, (select email from auth.users where id=i.counted_by) as counted_by_label,
      coalesce(sum(m.delta),0) as current_quantity,count(m.id) as current_movement_count,
      (count(m.id)<>i.basis_movement_count or coalesce(sum(m.delta),0)<>i.basis_quantity) as conflict
    from public.guigs_inventory_items i left join public.guigs_movements m
      on m.shop_id=i.shop_id and m.lot_id=i.lot_id and m.location=i.location
    where i.inventory_id=v.id group by i.id
  ) q;
  select coalesce(jsonb_agg((case when v.status='open' then to_jsonb(a)-'basis_quantity' else to_jsonb(a) end)||jsonb_build_object('actor_label',(select email from auth.users where id=a.actor_id)) order by a.created_at,a.id),'[]'::jsonb) into v_audit from public.guigs_inventory_audit a where a.inventory_id=v.id;
  select count(*) into v_new from public.guigs_lots l join public.guigs_products p on p.id=l.product_id and p.shop_id=l.shop_id
    where l.shop_id=p_shop_id and (p.active or exists(select 1 from public.guigs_movements b where b.shop_id=l.shop_id and b.lot_id=l.id group by b.location having sum(b.delta)>0))
    and not exists(select 1 from public.guigs_inventory_items i where i.inventory_id=v.id and i.lot_id=l.id);
  return jsonb_build_object('inventory',to_jsonb(v)||jsonb_build_object('started_by_label',(select email from auth.users where id=v.started_by),'completed_by_label',(select email from auth.users where id=v.completed_by)),'items',v_items,'audit',v_audit,'new_lots',v_new,
    'movements_after_start',greatest(0,(select count(*) from public.guigs_movements where shop_id=p_shop_id)-v.start_movement_count));
end $$;

create or replace function public.guigs_get_spatial_inventory(p_shop_id uuid,p_inventory_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v public.guigs_inventories; v_items jsonb; v_audit jsonb; v_new integer;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop_id and id=p_inventory_id;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if not v.spatial then raise exception 'Inventário não é espacial.'; end if;
  select coalesce(jsonb_agg((case when v.status='open' then to_jsonb(q)-array['expected_initial','basis_quantity','current_quantity','initial_movement_count','basis_movement_count','current_movement_count','applied_delta'] else to_jsonb(q) end) order by q.product_name,q.expiry,q.lot_id,q.location,q.slot_label,q.slot_id),'[]'::jsonb) into v_items from (
    select i.*, (select email from auth.users where id=i.counted_by) as counted_by_label,
      coalesce(sum(m.delta),0) as current_quantity,count(m.id) as current_movement_count,
      (count(m.id)<>i.basis_movement_count or coalesce(sum(m.delta),0)<>i.basis_quantity) as conflict
    from public.guigs_inventory_items i left join public.guigs_movements m
      on m.shop_id=i.shop_id and m.lot_id=i.lot_id and m.location=i.location and m.slot_id is not distinct from i.slot_id
    where i.inventory_id=v.id group by i.id
  ) q;
  select coalesce(jsonb_agg((case when v.status='open' then to_jsonb(a)-'basis_quantity' else to_jsonb(a) end)||jsonb_build_object('actor_label',(select email from auth.users where id=a.actor_id)) order by a.created_at,a.id),'[]'::jsonb) into v_audit from public.guigs_inventory_audit a where a.inventory_id=v.id;
  v_new:=case when v.status in ('open','review') then guigs_private.spatial_inventory_missing(p_shop_id,v.id) else 0 end;
  return jsonb_build_object('inventory',to_jsonb(v)||jsonb_build_object('started_by_label',(select email from auth.users where id=v.started_by),'completed_by_label',(select email from auth.users where id=v.completed_by)),'items',v_items,'audit',v_audit,'new_lots',v_new,
    'movements_after_start',greatest(0,(select count(*) from public.guigs_movements where shop_id=p_shop_id)-v.start_movement_count));
end $$;

create or replace function public.guigs_get_reports(
  p_shop_id uuid, p_from timestamptz, p_to timestamptz,
  p_limit integer default 50, p_loss_offset integer default 0,
  p_inventory_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Relatórios disponíveis apenas ao proprietário.';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
     or p_to <= p_from or p_to-p_from > interval '366 days' then
    raise exception 'Período inválido: escolha até 366 dias.';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or p_loss_offset is null
     or p_inventory_offset is null or p_loss_offset < 0 or p_inventory_offset < 0 then
    raise exception 'Paginação inválida.';
  end if;

  with period as materialized (
    select m.event_id,m.movement_type,m.delta,m.actor_id,m.note,m.created_at,m.id,m.location,m.slot_id,m.slot_label,
      l.code as lot,p.id as product_id,p.name as product
    from public.guigs_movements m
    join public.guigs_lots l on l.shop_id=m.shop_id and l.id=m.lot_id
    join public.guigs_products p on p.shop_id=l.shop_id and p.id=l.product_id
    where m.shop_id=p_shop_id and m.created_at>=p_from and m.created_at<p_to
  ), spatial_summary as (
    select f.id as fridge_id,f.name as fridge_name,
      count(distinct p.event_id) filter(where p.movement_type='transfer' and p.delta>0) as replenishment_events,
      coalesce(sum(p.delta) filter(where p.movement_type='transfer' and p.delta>0),0) as replenished_units,
      coalesce(-sum(p.delta) filter(where p.movement_type='sale' and p.delta<0),0) as sale_units,
      coalesce(-sum(p.delta) filter(where p.movement_type='loss' and p.delta<0),0) as loss_units
    from period p join public.guigs_fridge_slots x on x.shop_id=p_shop_id and x.id=p.slot_id
    join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
    where p.movement_type in ('transfer','sale','loss') group by f.id,f.name
  ), summary as (
    select count(distinct event_id) filter(where movement_type='receipt') as receipt_operations,
      coalesce(sum(delta) filter(where movement_type='receipt' and delta>0),0) as receipt_units,
      count(distinct event_id) filter(where movement_type='sale') as sale_operations,
      coalesce(-sum(delta) filter(where movement_type='sale' and delta<0),0) as sale_units,
      count(distinct event_id) filter(where movement_type='loss') as loss_operations,
      coalesce(-sum(delta) filter(where movement_type='loss' and delta<0),0) as loss_units,
      count(distinct event_id) filter(where movement_type in ('transfer','return')) as transfer_operations,
      coalesce(sum(delta) filter(where movement_type in ('transfer','return') and delta>0),0) as transfer_units,
      count(distinct event_id) filter(where movement_type='adjust') as adjust_operations,
      coalesce(sum(delta) filter(where movement_type='adjust'),0) as adjust_net_units
    from period
  ), sales as (
    select product_id,product,-sum(delta) as units from period where movement_type='sale' and delta<0
    group by product_id,product
  ), losses as (
    select product_id,product,-sum(delta) as units from period where movement_type='loss' and delta<0
    group by product_id,product
  ), suppliers as (
    -- Apenas snapshot gravado pela 006. Não atribuir o fornecedor ATUAL do lote ao passado.
    -- Linhas legadas sem snapshot permanecem não informadas.
    select case when note like 'Fornecedor: %' then
      coalesce(nullif(btrim(split_part(substr(note,13),E'\n',1)),''),'Não informado')
      else 'Não informado' end as supplier,
      count(distinct event_id) as operations,sum(delta) as units,max(created_at) as latest
    from period where movement_type='receipt' and delta>0 group by 1
  ), activity as (
    select actor_id,coalesce(u.email::text,'Usuário desconhecido') as actor,
      count(distinct event_id) filter(where movement_type='receipt') as receipts,
      count(distinct event_id) filter(where movement_type in ('transfer','return')) as transfers,
      count(distinct event_id) filter(where movement_type='sale') as sales,
      count(distinct event_id) filter(where movement_type='loss') as losses,
      count(distinct event_id) filter(where movement_type='adjust') as adjustments
    from period left join auth.users u on u.id=actor_id group by actor_id,u.email
  ), inventory_heads as materialized (
    select i.id,i.status,i.started_at,coalesce(i.completed_at,i.cancelled_at,i.started_at) as date,
      coalesce(u.email::text,'Usuário desconhecido') as actor
    from public.guigs_inventories i left join auth.users u on u.id=i.started_by where i.shop_id=p_shop_id
  ), inventory_page as materialized (
    select id from inventory_heads where status in ('completed','cancelled') and date>=p_from and date<p_to
      order by date desc,id desc limit p_limit offset p_inventory_offset
  ), inventory_selected as (
    (select id from inventory_heads order by started_at desc,id desc limit 1)
    union
    select id from inventory_page
  ), inventories as (
    select i.*,
      (select count(*) from public.guigs_inventory_items x where x.shop_id=p_shop_id and x.inventory_id=i.id) as items,
      (select count(*) from public.guigs_inventory_items x where x.shop_id=p_shop_id and x.inventory_id=i.id and x.counted_quantity is not null) as counted,
      case when i.status<>'open' then (select count(*) from public.guigs_inventory_items x where x.shop_id=p_shop_id and x.inventory_id=i.id and x.counted_quantity is not null and x.counted_quantity<>x.basis_quantity) end as divergent
    from inventory_heads i join inventory_selected s on s.id=i.id
  ), current_balances as (
    select lot_id,coalesce(sum(delta) filter(where location='stock'),0) as stock,
      coalesce(sum(delta) filter(where location='fridge'),0) as fridge
    from public.guigs_movements where shop_id=p_shop_id group by lot_id
  )
  select jsonb_build_object(
    'summary',(select to_jsonb(s) from summary s),
    'spatial_summary',coalesce((select jsonb_agg(to_jsonb(s)-'fridge_id' order by s.fridge_name,s.fridge_id) from spatial_summary s),'[]'::jsonb),
    'sales',coalesce((select jsonb_agg(to_jsonb(x)-'product_id') from (select * from sales order by units desc,product,product_id limit p_limit)x),'[]'::jsonb),
    'sales_count',(select count(*) from sales),
    'loss_ranking',coalesce((select jsonb_agg(to_jsonb(x)-'product_id') from (select * from losses order by units desc,product,product_id limit p_limit)x),'[]'::jsonb),
    'loss_ranking_count',(select count(*) from losses),
    'losses',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select p.product,p.lot,-p.delta as units,p.created_at as date,
        coalesce(u.email::text,'Usuário desconhecido') as actor,p.note,
        case when p.location='stock' then 'Estoque seco' else coalesce(p.slot_label,'Geladeira — não alocado') end as location_label
      from period p left join auth.users u on u.id=p.actor_id where p.movement_type='loss' and p.delta<0
      order by p.created_at desc,p.id desc limit p_limit offset p_loss_offset)x),'[]'::jsonb),
    'loss_count',(select count(*) from period where movement_type='loss' and delta<0),
    'suppliers',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from suppliers order by units desc,supplier limit p_limit)x),'[]'::jsonb),
    'supplier_count',(select count(*) from suppliers),
    'activity',coalesce((select jsonb_agg(to_jsonb(x)-'actor_id') from (select * from activity order by actor,actor_id limit p_limit)x),'[]'::jsonb),
    'activity_count',(select count(*) from activity),
    'latest_inventory',(select to_jsonb(x)-'id' from inventories x order by started_at desc,id desc limit 1),
    'inventories',coalesce((select jsonb_agg(to_jsonb(x)-'id') from (select * from inventories
      where id in (select id from inventory_page)
      order by date desc,id desc)x),'[]'::jsonb),
    'inventory_count',(select count(*) from inventory_heads where status in ('completed','cancelled') and date>=p_from and date<p_to),
    'stock',jsonb_build_object(
      'products',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active,'min_total',min_total,'min_fridge',min_fridge,'target_fridge',target_fridge)) from public.guigs_products where shop_id=p_shop_id),'[]'::jsonb),
      'lots',coalesce((select jsonb_agg(jsonb_build_object('id',id,'product_id',product_id,'code',code,'expiry',expiry,'created_at',created_at)) from public.guigs_lots where shop_id=p_shop_id),'[]'::jsonb),
      'balances',coalesce((select jsonb_agg(to_jsonb(b)) from current_balances b),'[]'::jsonb)
    )
  ) into result;
  return result;
end $$;

commit;
