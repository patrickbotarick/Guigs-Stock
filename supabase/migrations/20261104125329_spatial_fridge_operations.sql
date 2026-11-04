-- v1.7G: saídas e ajustes na partição selecionada do ledger.
begin;
set local lock_timeout='5s';
create function public.guigs_get_fridge_operation(p_shop_id uuid,p_spec jsonb)
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
revoke all on function public.guigs_get_fridge_operation(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.guigs_get_fridge_operation(uuid,jsonb) to authenticated;

create function public.guigs_apply_fridge_operation(p_shop_id uuid,p_request_id uuid,p_spec jsonb,p_expected jsonb,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare op text:=p_spec->>'kind'; cached jsonb; quote jsonb; item record; v_event uuid:=gen_random_uuid(); note text:=btrim(coalesce(p_note,''));
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if op='adjust' and guigs_private.member_role(p_shop_id) is distinct from 'owner' then raise exception 'Somente proprietários podem ajustar saldo.'; end if;
  if length(note)>1000 or (op in ('loss','adjust') and note='') then raise exception 'Informe o motivo (até 1000 caracteres).'; end if;
  perform guigs_private.spatial_stock_gate();
  cached:=guigs_private.begin_spatial_command(p_shop_id,p_request_id,'fridge-operation',jsonb_build_object('spec',p_spec,'expected',p_expected,'note',note));
  if cached is not null then return cached; end if;
  if op='sale' then
    perform 1 from public.guigs_products p where p.shop_id=p_shop_id and p.id=(p_spec->>'product_id')::uuid for share;
  end if;
  quote:=public.guigs_get_fridge_operation(p_shop_id,p_spec);
  if quote is distinct from p_expected then raise exception 'Origem ou saldo mudou. Recalcule a operação antes de confirmar.'; end if;
  for item in select * from jsonb_to_recordset(quote->'plan') as x(lot_id uuid,slot_id uuid,delta integer) loop
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
      values(p_shop_id,item.lot_id,v_event,op,'fridge',item.delta,auth.uid(),note,item.slot_id,true);
    if op='return' then
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,spatial)
        values(p_shop_id,item.lot_id,v_event,op,'stock',-item.delta,auth.uid(),note,true);
    end if;
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,quote||jsonb_build_object('event_id',v_event));
end $$;
revoke all on function public.guigs_apply_fridge_operation(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.guigs_apply_fridge_operation(uuid,uuid,jsonb,jsonb,text) to authenticated;
commit;
