-- Guig's Stock 1.5 — aplicar após 001..005, primeiro em homologação.
-- Não altera dados antigos nem concede escrita direta ao navegador.
begin;

create table public.guigs_suppliers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.guigs_shops(id),
  name text not null check (length(trim(name)) between 1 and 160),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (shop_id, id)
);
create unique index guigs_suppliers_shop_name_idx
  on public.guigs_suppliers (shop_id, lower(trim(name)));

alter table public.guigs_lots add column supplier_id uuid;
alter table public.guigs_lots add constraint guigs_lots_supplier_fk
  foreign key (shop_id, supplier_id) references public.guigs_suppliers(shop_id, id);
create index guigs_lots_supplier_idx on public.guigs_lots(shop_id, supplier_id);
create index guigs_lots_fefo_idx
  on public.guigs_lots(shop_id, product_id, expiry, created_at, id);

alter table public.guigs_suppliers enable row level security;
revoke all on public.guigs_suppliers from public, anon, authenticated;
grant select on public.guigs_suppliers to authenticated;
create policy guigs_suppliers_read on public.guigs_suppliers
  for select to authenticated using (guigs_private.is_member(shop_id));

create function public.guigs_create_supplier(p_shop_id uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_name text := trim(coalesce(p_name, ''));
begin
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Apenas proprietários podem gerenciar fornecedores.';
  end if;
  if length(v_name) not between 1 and 160 or p_active is null then
    raise exception 'Nome ou situação do fornecedor inválidos.';
  end if;
  insert into public.guigs_suppliers(shop_id, name, active)
    values (p_shop_id, v_name, p_active) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Já existe um fornecedor com esse nome.';
end;
$$;

create function public.guigs_update_supplier(p_shop_id uuid, p_supplier_id uuid, p_name text, p_active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then
    raise exception 'Apenas proprietários podem gerenciar fornecedores.';
  end if;
  if length(v_name) not between 1 and 160 or p_active is null then
    raise exception 'Nome ou situação do fornecedor inválidos.';
  end if;
  update public.guigs_suppliers set name = v_name, active = p_active
    where shop_id = p_shop_id and id = p_supplier_id;
  if not found then raise exception 'Fornecedor não encontrado.'; end if;
  return true;
exception when unique_violation then
  raise exception 'Já existe um fornecedor com esse nome.';
end;
$$;

-- Nova assinatura sem defaults: não deixa a resolução do PostgREST ambígua.
create function public.guigs_receive_stock(
  p_shop_id uuid, p_product_id uuid, p_lot_code text, p_expiry date,
  p_quantity integer, p_note text, p_supplier_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lot_id uuid;
  v_existing_supplier uuid;
  v_supplier_name text;
  v_event_id uuid := gen_random_uuid();
  v_code text := trim(coalesce(p_lot_code, ''));
  v_note text := coalesce(p_note, '');
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado.'; end if;
  if guigs_private.member_role(p_shop_id) is null then
    raise exception 'Usuário sem vínculo ativo com a pizzaria.';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'A quantidade recebida deve ser maior que zero.';
  end if;
  if p_expiry is null then raise exception 'A validade é obrigatória.'; end if;
  if p_expiry < current_date then
    raise exception 'Não é permitido receber um lote já vencido.';
  end if;
  if length(v_code) not between 1 and 120 then raise exception 'Código do lote inválido.'; end if;
  if not exists (select 1 from public.guigs_products p
    where p.shop_id = p_shop_id and p.id = p_product_id and p.active) then
    raise exception 'Produto inexistente ou inativo.';
  end if;
  if p_supplier_id is not null then
    -- Impede inativação/renomeação durante o recebimento e captura o nome para auditoria.
    select s.name into v_supplier_name from public.guigs_suppliers s
      where s.shop_id = p_shop_id and s.id = p_supplier_id and s.active for share;
    if not found then raise exception 'Fornecedor inexistente ou inativo nesta loja.'; end if;
    v_note := 'Fornecedor: ' || v_supplier_name
      || case when v_note = '' then '' else E'\n' || v_note end;
  end if;
  if length(v_note) > 1000 then
    raise exception 'Observação e nome do fornecedor excedem 1000 caracteres.';
  end if;

  -- O UPSERT preserva o fornecedor e serializa recebimentos do mesmo lote.
  insert into public.guigs_lots(shop_id, product_id, code, expiry, supplier_id)
    values (p_shop_id, p_product_id, v_code, p_expiry, p_supplier_id)
    on conflict (shop_id, product_id, code, expiry)
    do update set code = excluded.code
    returning id, supplier_id into v_lot_id, v_existing_supplier;

  if p_supplier_id is not null and v_existing_supplier is not null
    and p_supplier_id <> v_existing_supplier then
    raise exception 'Este lote já pertence a outro fornecedor. Use um código de lote distinto.';
  end if;
  if p_supplier_id is not null and v_existing_supplier is null then
    update public.guigs_lots set supplier_id = p_supplier_id
      where shop_id = p_shop_id and id = v_lot_id;
  end if;
  insert into public.guigs_movements(shop_id, lot_id, event_id, movement_type, location, delta, actor_id, note)
    values (p_shop_id, v_lot_id, v_event_id, 'receipt', 'stock', p_quantity, auth.uid(), v_note);
  return jsonb_build_object('success', true, 'event_id', v_event_id, 'lot_id', v_lot_id,
    'quantity', p_quantity, 'location', 'stock');
end;
$$;

-- Mantém clientes 1.5 antigos: NULL não apaga o fornecedor já vinculado.
create or replace function public.guigs_receive_stock(
  p_shop_id uuid, p_product_id uuid, p_lot_code text, p_expiry date,
  p_quantity integer, p_note text default ''
)
returns jsonb language sql security definer set search_path = '' as $$
  select public.guigs_receive_stock(p_shop_id, p_product_id, p_lot_code, p_expiry,
    p_quantity, p_note, null::uuid);
$$;

-- Consulta somente leitura: saldo real, mesmo produto/loja e desempate por criação.
-- O aviso não muda a RPC de transferência nem suas garantias de concorrência.
create function public.guigs_get_fefo_candidates(p_shop_id uuid, p_lot_id uuid)
returns table(lot_id uuid, code text, expiry date, created_at timestamptz, stock bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_selected public.guigs_lots%rowtype;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select l.* into v_selected from public.guigs_lots l
    where l.shop_id = p_shop_id and l.id = p_lot_id;
  if not found then raise exception 'Lote não encontrado.'; end if;
  return query
    select l.id, l.code, l.expiry, l.created_at, sum(m.delta)::bigint
    from public.guigs_lots l
    join public.guigs_movements m on m.shop_id = l.shop_id and m.lot_id = l.id and m.location = 'stock'
    where l.shop_id = p_shop_id and l.product_id = v_selected.product_id and l.id <> v_selected.id
      and (l.expiry < v_selected.expiry
        or (l.expiry = v_selected.expiry and l.created_at < v_selected.created_at))
    group by l.id
    having sum(m.delta) > 0
    order by l.expiry, l.created_at, l.id;
end;
$$;

revoke all on function public.guigs_create_supplier(uuid, text, boolean) from public, anon;
revoke all on function public.guigs_update_supplier(uuid, uuid, text, boolean) from public, anon;
revoke all on function public.guigs_receive_stock(uuid, uuid, text, date, integer, text, uuid) from public, anon;
revoke all on function public.guigs_receive_stock(uuid, uuid, text, date, integer, text) from public, anon;
revoke all on function public.guigs_get_fefo_candidates(uuid, uuid) from public, anon;
grant execute on function public.guigs_create_supplier(uuid, text, boolean) to authenticated;
grant execute on function public.guigs_update_supplier(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.guigs_receive_stock(uuid, uuid, text, date, integer, text, uuid) to authenticated;
grant execute on function public.guigs_receive_stock(uuid, uuid, text, date, integer, text) to authenticated;
grant execute on function public.guigs_get_fefo_candidates(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
