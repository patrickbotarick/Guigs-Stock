-- v1.6D: somente preparação. NÃO aplicar no Supabase real nesta etapa.
begin;

-- O índice existente (shop_id,created_at desc) da 003 atende ao período.
-- Sem índices novos até medição em homologação com volume representativo.
create function public.guigs_get_reports(
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
    select m.event_id,m.movement_type,m.delta,m.actor_id,m.note,m.created_at,m.id,
      l.code as lot,p.id as product_id,p.name as product
    from public.guigs_movements m
    join public.guigs_lots l on l.shop_id=m.shop_id and l.id=m.lot_id
    join public.guigs_products p on p.shop_id=l.shop_id and p.id=l.product_id
    where m.shop_id=p_shop_id and m.created_at>=p_from and m.created_at<p_to
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
      (select count(*) from public.guigs_inventory_items x where x.shop_id=p_shop_id and x.inventory_id=i.id and x.counted_quantity is not null and x.counted_quantity<>x.basis_quantity) as divergent
    from inventory_heads i join inventory_selected s on s.id=i.id
  ), current_balances as (
    select lot_id,coalesce(sum(delta) filter(where location='stock'),0) as stock,
      coalesce(sum(delta) filter(where location='fridge'),0) as fridge
    from public.guigs_movements where shop_id=p_shop_id group by lot_id
  )
  select jsonb_build_object(
    'summary',(select to_jsonb(s) from summary s),
    'sales',coalesce((select jsonb_agg(to_jsonb(x)-'product_id') from (select * from sales order by units desc,product,product_id limit p_limit)x),'[]'::jsonb),
    'sales_count',(select count(*) from sales),
    'loss_ranking',coalesce((select jsonb_agg(to_jsonb(x)-'product_id') from (select * from losses order by units desc,product,product_id limit p_limit)x),'[]'::jsonb),
    'loss_ranking_count',(select count(*) from losses),
    'losses',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select p.product,p.lot,-p.delta as units,p.created_at as date,
        coalesce(u.email::text,'Usuário desconhecido') as actor,p.note
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
revoke all on function public.guigs_get_reports(uuid,timestamptz,timestamptz,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.guigs_get_reports(uuid,timestamptz,timestamptz,integer,integer,integer) to authenticated;
commit;
