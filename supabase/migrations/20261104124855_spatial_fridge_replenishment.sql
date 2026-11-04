-- v1.7F: seleção FEFO compartilhada e reposição atômica.
begin;
set local lock_timeout='5s';

create function guigs_private.dry_fefo(p_shop uuid,p_product uuid)
returns table(lot_id uuid,code text,expiry date,created_at timestamptz,stock bigint)
language sql stable security invoker set search_path='' as $$
  select l.id,l.code,l.expiry,l.created_at,sum(m.delta)::bigint
  from public.guigs_lots l join public.guigs_movements m
    on (m.shop_id,m.lot_id)=(l.shop_id,l.id) and m.location='stock'
  where l.shop_id=p_shop and l.product_id=p_product
  group by l.id having sum(m.delta)>0
  order by l.expiry,l.created_at,l.id;
$$;
revoke all on function guigs_private.dry_fefo(uuid,uuid) from public,anon,authenticated;
grant execute on function guigs_private.dry_fefo(uuid,uuid) to authenticated;

-- A assinatura e o filtro de candidatos do cliente legado são preservados.
create or replace function public.guigs_get_fefo_candidates(p_shop_id uuid,p_lot_id uuid)
returns table(lot_id uuid,code text,expiry date,created_at timestamptz,stock bigint)
language plpgsql stable security definer set search_path='' as $$
declare selected public.guigs_lots%rowtype;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select l.* into selected from public.guigs_lots l where l.shop_id=p_shop_id and l.id=p_lot_id;
  if not found then raise exception 'Lote não encontrado.'; end if;
  return query select d.* from guigs_private.dry_fefo(p_shop_id,selected.product_id) d
  where d.lot_id<>selected.id and (d.expiry,d.created_at)<(selected.expiry,selected.created_at)
  order by d.expiry,d.created_at,d.lot_id;
end $$;
revoke all on function public.guigs_get_fefo_candidates(uuid,uuid) from public,anon,authenticated;
grant execute on function public.guigs_get_fefo_candidates(uuid,uuid) to authenticated;

create function public.guigs_get_fridge_replenishment(p_shop_id uuid,p_slot_id uuid,p_quantity integer default null)
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
revoke all on function public.guigs_get_fridge_replenishment(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.guigs_get_fridge_replenishment(uuid,uuid,integer) to authenticated;

create function public.guigs_replenish_fridge_slot(p_shop_id uuid,p_request_id uuid,p_slot_id uuid,p_quantity integer,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cached jsonb; quote jsonb; e record; v_event uuid:=gen_random_uuid();
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_quantity is null or p_quantity not between 1 and 1000000 or jsonb_typeof(p_plan) is distinct from 'array'
    then raise exception 'Quantidade ou plano inválido.'; end if;
  perform guigs_private.spatial_stock_gate();
  cached:=guigs_private.begin_spatial_command(p_shop_id,p_request_id,'replenish',jsonb_build_object('slot',p_slot_id,'quantity',p_quantity,'plan',p_plan));
  if cached is not null then return cached; end if;
  perform 1 from public.guigs_products p join public.guigs_fridge_slots x
    on (x.shop_id,x.product_id)=(p.shop_id,p.id) where x.shop_id=p_shop_id and x.id=p_slot_id for share of p;
  quote:=public.guigs_get_fridge_replenishment(p_shop_id,p_slot_id,p_quantity);
  if (quote->>'quantity')::integer is distinct from p_quantity or quote->'plan' is distinct from p_plan then
    raise exception 'Plano FEFO mudou. Atualize a sugestão antes de confirmar.';
  end if;
  for e in select * from jsonb_to_recordset(quote->'plan') as x(lot_id uuid,quantity integer) loop
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
      values(p_shop_id,e.lot_id,v_event,'transfer','stock',-e.quantity,auth.uid(),'Reposição visual',null,true),
            (p_shop_id,e.lot_id,v_event,'transfer','fridge',e.quantity,auth.uid(),'Reposição visual',p_slot_id,true);
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,jsonb_build_object('event_id',v_event,'quantity',p_quantity));
end $$;
revoke all on function public.guigs_replenish_fridge_slot(uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.guigs_replenish_fridge_slot(uuid,uuid,uuid,integer,jsonb) to authenticated;
commit;
