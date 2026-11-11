begin;
set local lock_timeout='5s';

create index guigs_movements_slot_history_idx
  on public.guigs_movements(shop_id,slot_id,created_at desc,event_id desc) where slot_id is not null;
create index guigs_inventory_items_adjustment_idx
  on public.guigs_inventory_items(shop_id,adjustment_event_id) where adjustment_event_id is not null;
create index guigs_spatial_commands_replenish_event_idx
  on guigs_private.spatial_commands(shop_id,(result->>'event_id')) where command='replenish';

create function public.guigs_get_fridge_slot_history(
  p_shop_id uuid,p_slot_id uuid,p_limit integer default 12,
  p_before_at timestamptz default null,p_before_event uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_limit is null or p_limit not between 1 and 50 or (p_before_at is null)<>(p_before_event is null)
  then raise exception 'Paginação inválida.'; end if;
  if not exists(select 1 from public.guigs_fridge_slots where shop_id=p_shop_id and id=p_slot_id)
  then raise exception 'Bloco indisponível nesta loja.'; end if;
  with candidates as materialized (
    select m.event_id,max(m.created_at) as created_at
    from public.guigs_movements m
    where m.shop_id=p_shop_id and m.slot_id=p_slot_id
    group by m.event_id
    having p_before_at is null or (max(m.created_at),m.event_id)<(p_before_at,p_before_event)
    order by created_at desc,m.event_id desc limit p_limit+1
  ), page as (
    select * from candidates order by created_at desc,event_id desc limit p_limit
  ), entries as (
    select k.event_id,k.created_at,min(split_part(u.email,'@',1)) as operator,
      case
        when exists(select 1 from public.guigs_inventory_items i
          where i.shop_id=p_shop_id and i.adjustment_event_id=k.event_id) then 'inventory'
        when min(m.movement_type)='transfer' and exists(select 1 from guigs_private.spatial_commands c
          where c.shop_id=p_shop_id and c.command='replenish' and c.result->>'event_id'=k.event_id::text) then 'replenish'
        when min(m.movement_type)='relocate' and bool_or(m.delta<0 and m.slot_id is not null) then 'slot_move'
        else min(m.movement_type)
      end as kind,
      jsonb_agg(jsonb_build_object('product_name',p.name,'lot_code',l.code,'expiry',l.expiry,'delta',m.delta,
        'in_block',coalesce(m.slot_id=p_slot_id,false),'label',case when m.location='stock' then 'Estoque seco'
          else coalesce(m.slot_label,'Geladeira — não alocado') end)
        order by m.delta>0,l.expiry,l.id,m.id) as parts
    from page k join public.guigs_movements m on m.shop_id=p_shop_id and m.event_id=k.event_id and m.spatial
    join public.guigs_lots l on (l.shop_id,l.id)=(m.shop_id,m.lot_id)
    join public.guigs_products p on (p.shop_id,p.id)=(l.shop_id,l.product_id)
    left join auth.users u on u.id=m.actor_id
    group by k.event_id,k.created_at
  )
  select jsonb_build_object('events',coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.event_id desc),'[]'),
    'has_more',(select count(*)>p_limit from candidates)) into result from entries e;
  return result;
end $$;

create function public.guigs_quote_fridge_slot_move(p_shop_id uuid,p_source uuid,p_destination uuid,
  p_lot uuid default null,p_quantity integer default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare source record; destination record; plan jsonb; quantity bigint; space bigint;
  incompatible boolean; expired boolean;
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_source is null or p_destination is null or p_source=p_destination then raise exception 'Escolha blocos diferentes.'; end if;
  if (p_lot is null)<>(p_quantity is null) or (p_quantity is not null and p_quantity not between 1 and 1000000)
  then raise exception 'Informe um lote e uma quantidade inteira positiva, ou escolha consolidar.'; end if;
  if exists(select 1 from public.guigs_inventories i where i.shop_id=p_shop_id and i.status in ('open','review'))
  then raise exception 'Finalize ou cancele o inventário ativo antes de mover entre blocos.'; end if;

  select f.name||' / '||h.name||' / '||x.name as label into source
  from public.guigs_fridge_slots x join public.guigs_fridge_shelves h
    on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
  join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
  where x.shop_id=p_shop_id and x.id=p_source and x.active and h.active and f.active;
  if not found then raise exception 'Origem indisponível nesta loja.'; end if;
  select x.product_id,x.capacity_quantity,p.name as product_name,f.name||' / '||h.name||' / '||x.name as label
  into destination from public.guigs_fridge_slots x join public.guigs_fridge_shelves h
    on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
  join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
  left join public.guigs_products p on (p.shop_id,p.id)=(x.shop_id,x.product_id)
  where x.shop_id=p_shop_id and x.id=p_destination and x.active and h.active and f.active;
  if not found then raise exception 'Destino indisponível nesta loja.'; end if;
  if destination.product_id is null then raise exception 'Associe um produto ao bloco de destino.'; end if;
  if destination.capacity_quantity is null then raise exception 'Configure a capacidade do bloco de destino.'; end if;

  with source_lots as (
    select l.id,l.code,l.expiry,l.created_at,l.product_id,sum(m.delta) as available
    from public.guigs_movements m join public.guigs_lots l on (l.shop_id,l.id)=(m.shop_id,m.lot_id)
    where m.shop_id=p_shop_id and m.slot_id=p_source and (p_lot is null or l.id=p_lot)
    group by l.id having sum(m.delta)>0
  )
  select coalesce(sum(coalesce(p_quantity,l.available)),0),bool_or(l.product_id<>destination.product_id),
    bool_or(l.expiry<current_date),jsonb_agg(jsonb_build_object('lot_id',l.id,'code',l.code,'expiry',l.expiry,
      'available',l.available,'quantity',coalesce(p_quantity,l.available)) order by l.expiry,l.created_at,l.id)
  into quantity,incompatible,expired,plan from source_lots l;
  if quantity=0 or (p_lot is not null and (plan->0->>'available')::bigint<p_quantity)
  then raise exception 'Saldo insuficiente do lote na origem.'; end if;
  if incompatible then raise exception 'Produto incompatível com o bloco de destino.'; end if;
  if expired then raise exception 'Lotes vencidos devem ser tratados na origem antes da reorganização.'; end if;
  select destination.capacity_quantity-coalesce(sum(delta),0) into space
    from public.guigs_movements where shop_id=p_shop_id and slot_id=p_destination;
  if quantity>space then raise exception 'Espaço insuficiente no destino. Disponível: %.',space; end if;
  return jsonb_build_object('source',source.label,'destination',destination.label,
    'product_name',destination.product_name,'quantity',quantity,'space',space,'lots',plan);
end $$;

create function public.guigs_apply_fridge_slot_move(p_shop_id uuid,p_request_id uuid,p_source uuid,
  p_destination uuid,p_lot uuid,p_quantity integer,p_expected jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cached jsonb; quote jsonb; item record; event uuid:=gen_random_uuid();
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  perform guigs_private.spatial_stock_gate();
  cached:=guigs_private.begin_spatial_command(p_shop_id,p_request_id,'fridge-operation',
    jsonb_build_object('slot_move',jsonb_build_object('source',p_source,'destination',p_destination,'lot',p_lot,
      'quantity',p_quantity,'expected',p_expected)));
  if cached is not null then return cached; end if;
  quote:=public.guigs_quote_fridge_slot_move(p_shop_id,p_source,p_destination,p_lot,p_quantity);
  if quote is distinct from p_expected then raise exception 'A origem ou o destino mudou. Confira o novo plano antes de mover.'; end if;
  for item in select * from jsonb_to_recordset(quote->'lots') as x(lot_id uuid,quantity integer) loop
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
    values(p_shop_id,item.lot_id,event,'relocate','fridge',-item.quantity,auth.uid(),'Movimentação entre blocos',p_source,true),
          (p_shop_id,item.lot_id,event,'relocate','fridge',item.quantity,auth.uid(),'Movimentação entre blocos',p_destination,true);
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,quote||jsonb_build_object('event_id',event));
end $$;

revoke all on function public.guigs_get_fridge_slot_history(uuid,uuid,integer,timestamptz,uuid),
  public.guigs_quote_fridge_slot_move(uuid,uuid,uuid,uuid,integer),
  public.guigs_apply_fridge_slot_move(uuid,uuid,uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.guigs_get_fridge_slot_history(uuid,uuid,integer,timestamptz,uuid),
  public.guigs_quote_fridge_slot_move(uuid,uuid,uuid,uuid,integer),
  public.guigs_apply_fridge_slot_move(uuid,uuid,uuid,uuid,uuid,integer,jsonb) to authenticated;
commit;
