-- v1.7E: transferência interna entre não alocado e posições, sem novo saldo.
begin;
set local lock_timeout='5s';

alter table public.guigs_movements drop constraint guigs_movements_movement_type_check;
alter table public.guigs_movements add constraint guigs_movements_movement_type_check
  check (movement_type in ('receipt','transfer','return','sale','loss','adjust','relocate'));

create table guigs_private.spatial_commands (
  shop_id uuid not null references public.guigs_shops(id),
  request_id uuid not null,
  actor_id uuid not null references auth.users(id),
  command text not null,
  payload jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key(shop_id,request_id)
);
alter table guigs_private.spatial_commands enable row level security;
revoke all on guigs_private.spatial_commands from public,anon,authenticated;

-- Chamado somente depois do gate transacional; uma falha reverte chave e ledger juntos.
create function guigs_private.begin_spatial_command(p_shop uuid,p_request uuid,p_command text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare c guigs_private.spatial_commands%rowtype;
begin
  if p_request is null or auth.uid() is null then raise exception 'Identificador de operação obrigatório.'; end if;
  select * into c from guigs_private.spatial_commands where shop_id=p_shop and request_id=p_request;
  if found then
    if c.actor_id is distinct from auth.uid() or c.command is distinct from p_command
      or c.payload is distinct from p_payload or c.result is null then
      raise exception 'Identificador já utilizado para outra operação.';
    end if;
    return c.result;
  end if;
  insert into guigs_private.spatial_commands(shop_id,request_id,actor_id,command,payload)
    values(p_shop,p_request,auth.uid(),p_command,p_payload);
  return null;
end $$;
revoke all on function guigs_private.begin_spatial_command(uuid,uuid,text,jsonb) from public,anon,authenticated;

create function guigs_private.finish_spatial_command(p_shop uuid,p_request uuid,p_result jsonb)
returns jsonb language sql set search_path='' as $$
  update guigs_private.spatial_commands set result=p_result where shop_id=p_shop and request_id=p_request
    and actor_id=auth.uid() and result is null returning result;
$$;
revoke all on function guigs_private.finish_spatial_command(uuid,uuid,jsonb) from public,anon,authenticated;

create function public.guigs_allocate_fridge_stock(p_shop_id uuid,p_request_id uuid,p_entries jsonb)
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
    insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
      values(p_shop_id,e.lot_id,v_event,'relocate','fridge',-e.quantity,auth.uid(),'Distribuição de estoque existente',null,true),
            (p_shop_id,e.lot_id,v_event,'relocate','fridge',e.quantity,auth.uid(),'Distribuição de estoque existente',e.slot_id,true);
    v_total:=v_total+e.quantity;
  end loop;
  return guigs_private.finish_spatial_command(p_shop_id,p_request_id,jsonb_build_object('event_id',v_event,'quantity',v_total));
end $$;
revoke all on function public.guigs_allocate_fridge_stock(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.guigs_allocate_fridge_stock(uuid,uuid,jsonb) to authenticated;
commit;
