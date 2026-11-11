-- O ledger e o inventário são a evidência do resultado. Chaves antigas
-- continuam reservadas na tabela privada com o payload e resultado originais.
begin;
set local lock_timeout='5s';

create or replace function guigs_private.begin_spatial_command(p_shop uuid,p_request uuid,p_command text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare c guigs_private.spatial_commands%rowtype;
begin
  if p_request is null or auth.uid() is null then raise exception 'Identificador de operação obrigatório.'; end if;

  -- Os chamadores adquirem spatial_stock_gate antes de consultar a chave.
  select * into c from guigs_private.spatial_commands where shop_id=p_shop and request_id=p_request;
  if found then
    if c.actor_id is distinct from auth.uid() or c.command is distinct from p_command
       or c.payload is distinct from p_payload or c.result is null then
      raise exception 'Identificador já utilizado para outra operação.';
    end if;

    if c.command='complete-inventory' then
      if not exists (select 1 from public.guigs_inventories i
        where i.shop_id=p_shop and i.id=(c.result->>'inventory_id')::uuid
          and i.spatial and i.status='completed') then
        raise exception 'Esta solicitação pertence a um ciclo anterior ou perdeu seu resultado. Atualize os dados antes de continuar.';
      end if;
    elsif c.command in ('allocate','replenish','fridge-operation') then
      if not exists (select 1 from public.guigs_movements m
        where m.shop_id=p_shop and m.event_id=(c.result->>'event_id')::uuid and m.spatial) then
        raise exception 'Esta solicitação pertence a um ciclo anterior ou perdeu seu resultado. Atualize os dados antes de continuar.';
      end if;
    else
      raise exception 'Comando de idempotência desconhecido.';
    end if;
    return c.result;
  end if;

  insert into guigs_private.spatial_commands(shop_id,request_id,actor_id,command,payload)
    values(p_shop,p_request,auth.uid(),p_command,p_payload);
  return null;
end $$;

commit;
