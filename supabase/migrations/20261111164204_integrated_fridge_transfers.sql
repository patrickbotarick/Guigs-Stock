begin;
set local lock_timeout='5s';

create function public.guigs_quote_fridge_transfer(p_shop_id uuid,p_spec jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  direction text:=p_spec->>'direction';
  product uuid:=(p_spec->>'product_id')::uuid;
  lot uuid:=(p_spec->>'lot_id')::uuid;
  destination uuid:=(p_spec->>'slot_id')::uuid;
  quantity integer:=(p_spec->>'quantity')::integer;
  sources jsonb:=p_spec->'sources';
  position record;
  batch record;
  source record;
  available bigint;
  planned bigint;
  plan jsonb:='[]';
  destination_label text:='Geladeira — não alocado';
  space bigint;
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if direction is null or direction not in ('stock-fridge','fridge-stock') or product is null
     or quantity is null or quantity not between 1 and 1000000 then
    raise exception 'Informe produto, direção e quantidade válidos.';
  end if;
  if not exists (select 1 from public.guigs_products p where p.shop_id=p_shop_id and p.id=product
    and (direction='fridge-stock' or p.active)) then raise exception 'Produto indisponível nesta loja.'; end if;
  if exists (select 1 from public.guigs_inventories i where i.shop_id=p_shop_id and i.status in ('open','review')) then
    raise exception 'Finalize ou cancele o inventário ativo antes de transferir.';
  end if;
  if direction='stock-fridge' then
    if sources is not null then raise exception 'A origem é o estoque seco.'; end if;
    if destination is not null then
      select x.product_id,x.capacity_quantity,f.name||' / '||h.name||' / '||x.name as label
      into position from public.guigs_fridge_slots x
      join public.guigs_fridge_shelves h on (h.shop_id,h.fridge_id,h.id)=(x.shop_id,x.fridge_id,x.shelf_id)
      join public.guigs_fridges f on (f.shop_id,f.id)=(x.shop_id,x.fridge_id)
      where x.shop_id=p_shop_id and x.id=destination and x.active and h.active and f.active;
      if not found then raise exception 'Bloco indisponível nesta loja.'; end if;
      if position.product_id is distinct from product then
        raise exception 'Este bloco não está associado ao produto selecionado.';
      end if;
      if position.capacity_quantity is null then raise exception 'Este bloco ainda não possui capacidade configurada.'; end if;
      select position.capacity_quantity-coalesce(sum(m.delta),0) into space
        from public.guigs_movements m where m.shop_id=p_shop_id and m.slot_id=destination;
      if space<quantity then raise exception 'Espaço insuficiente no bloco. Disponível: %.',space; end if;
      destination_label:=position.label;
    end if;
    if lot is not null then
      select l.expiry into batch from public.guigs_lots l
        where l.shop_id=p_shop_id and l.id=lot and l.product_id=product;
      if not found then raise exception 'Lote indisponível para este produto.'; end if;
      if batch.expiry<current_date then raise exception 'Lotes vencidos não podem ser enviados para a geladeira.'; end if;
    end if;
    with candidates as (
      select d.*,coalesce(sum(d.stock) over(order by d.expiry,d.created_at,d.lot_id
        rows between unbounded preceding and 1 preceding),0) as earlier
      from guigs_private.dry_fefo(p_shop_id,product) d
      where d.expiry>=current_date and (lot is null or d.lot_id=lot)
    ), picked as (
      select c.*,least(c.stock,quantity-c.earlier)::integer as units
      from candidates c where c.earlier<quantity
    )
    select coalesce(sum(p.units),0),coalesce(jsonb_agg(jsonb_build_object('lot_id',p.lot_id,
      'code',p.code,'expiry',p.expiry,'quantity',p.units,'available',p.stock,
      'slot_id',destination,'label',destination_label) order by p.expiry,p.created_at,p.lot_id),'[]')
    into planned,plan from picked p;
    if planned<>quantity then raise exception 'Saldo seco não vencido insuficiente.'; end if;
  else
    destination_label:='Estoque seco';
    if lot is null or destination is not null or jsonb_typeof(sources) is distinct from 'array' then
      raise exception 'Selecione o lote e informe as origens do retorno.';
    end if;
    if jsonb_array_length(sources) not between 1 and 100
      or exists(select 1 from jsonb_to_recordset(sources) as x(slot_id uuid,quantity integer)
        where x.quantity is null or x.quantity not between 1 and 1000000)
      or exists(select 1 from jsonb_to_recordset(sources) as x(slot_id uuid) group by x.slot_id having count(*)>1)
    then raise exception 'Informe uma quantidade válida por origem, sem repetir posições.'; end if;
    select l.code,l.expiry into batch from public.guigs_lots l
      where l.shop_id=p_shop_id and l.id=lot and l.product_id=product;
    if not found then raise exception 'Lote indisponível para este produto.'; end if;
    planned:=0;
    for source in
      select x.slot_id,x.quantity,
        case when x.slot_id is null then 'Geladeira — não alocado' else f.name||' / '||h.name||' / '||s.name end as label
      from jsonb_to_recordset(sources) as x(slot_id uuid,quantity integer)
      left join public.guigs_fridge_slots s on s.shop_id=p_shop_id and s.id=x.slot_id and s.active
      left join public.guigs_fridge_shelves h on (h.shop_id,h.fridge_id,h.id)=(s.shop_id,s.fridge_id,s.shelf_id) and h.active
      left join public.guigs_fridges f on (f.shop_id,f.id)=(s.shop_id,s.fridge_id) and f.active
      order by x.slot_id nulls first
    loop
      if source.label is null then raise exception 'Origem física indisponível nesta loja.'; end if;
      select coalesce(sum(m.delta),0) into available from public.guigs_movements m
      where m.shop_id=p_shop_id and m.lot_id=lot and m.location='fridge' and m.slot_id is not distinct from source.slot_id;
      if available<source.quantity then raise exception 'Saldo insuficiente em %.',source.label; end if;
      planned:=planned+source.quantity;
      plan:=plan||jsonb_build_array(jsonb_build_object('lot_id',lot,'code',batch.code,'expiry',batch.expiry,
        'quantity',source.quantity,'available',available,'slot_id',source.slot_id,'label',source.label));
    end loop;
    if planned<>quantity then raise exception 'A soma das origens deve ser igual à quantidade do retorno.'; end if;
  end if;
  return jsonb_build_object('direction',direction,'product_id',product,'quantity',quantity,
    'destination',destination_label,'space',space,'plan',plan);
end $$;

create function public.guigs_apply_fridge_transfer(p_shop_id uuid,p_request_id uuid,p_spec jsonb,p_expected jsonb,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  cached jsonb;
  quote jsonb;
  item record;
  event uuid:=gen_random_uuid();
  outbound boolean:=p_spec->>'direction'='stock-fridge';
  note text:=btrim(coalesce(p_note,''));
  movement text;
begin
  if auth.uid() is null or not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if length(note)>1000 then raise exception 'Observação excede 1000 caracteres.'; end if;
  perform guigs_private.spatial_stock_gate();
  cached:=guigs_private.begin_spatial_command(p_shop_id,p_request_id,'fridge-operation',
    jsonb_build_object('integrated_transfer',p_spec,'expected',p_expected,'note',note));
  if cached is not null then return cached; end if;
  perform 1 from public.guigs_products p where p.shop_id=p_shop_id and p.id=(p_spec->>'product_id')::uuid for share;
  quote:=public.guigs_quote_fridge_transfer(p_shop_id,p_spec);
  if quote is distinct from p_expected then raise exception 'O saldo ou a posição mudou. Confira o novo plano antes de confirmar.'; end if;
  movement:=case when outbound then 'transfer' else 'return' end;
  for item in select * from jsonb_to_recordset(quote->'plan') as x(lot_id uuid,slot_id uuid,quantity integer) loop
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
    values
      (p_shop_id,item.lot_id,event,movement,case when outbound then 'stock' else 'fridge' end,
        -item.quantity,auth.uid(),note,case when outbound then null else item.slot_id end,true),
      (p_shop_id,item.lot_id,event,movement,case when outbound then 'fridge' else 'stock' end,
        item.quantity,auth.uid(),note,case when outbound then item.slot_id else null end,true);
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,quote||jsonb_build_object('event_id',event));
end $$;

revoke all on function public.guigs_quote_fridge_transfer(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.guigs_apply_fridge_transfer(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.guigs_quote_fridge_transfer(uuid,jsonb) to authenticated;
grant execute on function public.guigs_apply_fridge_transfer(uuid,uuid,jsonb,jsonb,text) to authenticated;
commit;
