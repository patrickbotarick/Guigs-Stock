-- ============================================================
-- GUIG'S STOCK 1.2C
-- 002_cloud_write_operations.sql
--
-- Operações seguras de escrita do estoque em nuvem.
--
-- IMPORTANTE:
-- - O frontend NÃO recebe permissão direta de INSERT/UPDATE/DELETE.
-- - As alterações são feitas exclusivamente por funções RPC.
-- - O usuário é identificado por auth.uid().
-- - Operações críticas validam vínculo, função e saldo no banco.
-- - Movimentações são append-only: o histórico não é apagado.
-- ============================================================

begin;


-- ============================================================
-- 1. GARANTIAS DE SEGURANÇA
-- ============================================================

-- Mantemos escrita direta bloqueada para clientes autenticados.
revoke insert, update, delete
on public.guigs_shops,
   public.guigs_memberships,
   public.guigs_products,
   public.guigs_lots,
   public.guigs_movements
from authenticated;

revoke all
on public.guigs_shops,
   public.guigs_memberships,
   public.guigs_products,
   public.guigs_lots,
   public.guigs_movements
from anon;


-- ============================================================
-- 2. HELPERS PRIVADOS
-- ============================================================

create schema if not exists guigs_private;


-- ------------------------------------------------------------
-- Retorna o papel ativo do usuário na pizzaria.
-- Retorna NULL quando o usuário não possui vínculo ativo.
-- ------------------------------------------------------------

create or replace function guigs_private.member_role(
    p_shop_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select m.role
    from public.guigs_memberships m
    where m.shop_id = p_shop_id
      and m.user_id = (select auth.uid())
      and m.active = true
    limit 1;
$$;

revoke all
on function guigs_private.member_role(uuid)
from public;


-- ------------------------------------------------------------
-- Calcula saldo atual de um lote em uma localização.
-- ------------------------------------------------------------

create or replace function guigs_private.lot_balance(
    p_shop_id uuid,
    p_lot_id uuid,
    p_location text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(sum(m.delta), 0)::integer
    from public.guigs_movements m
    where m.shop_id = p_shop_id
      and m.lot_id = p_lot_id
      and m.location = p_location;
$$;

revoke all
on function guigs_private.lot_balance(uuid, uuid, text)
from public;


-- ============================================================
-- 3. CADASTRO DE PRODUTOS
-- ============================================================

-- ------------------------------------------------------------
-- Criar produto
-- Somente OWNER.
-- ------------------------------------------------------------

create or replace function public.guigs_create_product(
    p_shop_id uuid,
    p_name text,
    p_category text default 'Outro',
    p_min_total integer default 0,
    p_target_total integer default 0,
    p_min_fridge integer default 0,
    p_target_fridge integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_product_id uuid;
    v_name text;
    v_category text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is distinct from 'owner' then
        raise exception 'Apenas proprietários podem cadastrar produtos.';
    end if;

    v_name := trim(coalesce(p_name, ''));
    v_category := trim(coalesce(p_category, 'Outro'));

    if length(v_name) < 1 or length(v_name) > 160 then
        raise exception 'Nome do produto inválido.';
    end if;

    if p_min_total < 0
       or p_target_total < p_min_total
       or p_min_fridge < 0
       or p_target_fridge < p_min_fridge then
        raise exception 'Limites de estoque inválidos.';
    end if;

    if exists (
        select 1
        from public.guigs_products p
        where p.shop_id = p_shop_id
          and lower(trim(p.name)) = lower(v_name)
    ) then
        raise exception 'Já existe um produto com esse nome.';
    end if;

    insert into public.guigs_products (
        shop_id,
        name,
        category,
        min_total,
        target_total,
        min_fridge,
        target_fridge,
        active
    )
    values (
        p_shop_id,
        v_name,
        case
            when length(v_category) = 0 then 'Outro'
            else v_category
        end,
        p_min_total,
        p_target_total,
        p_min_fridge,
        p_target_fridge,
        true
    )
    returning id into v_product_id;

    return v_product_id;
end;
$$;


-- ------------------------------------------------------------
-- Editar produto
-- Somente OWNER.
-- ------------------------------------------------------------

create or replace function public.guigs_update_product(
    p_shop_id uuid,
    p_product_id uuid,
    p_name text,
    p_category text,
    p_min_total integer,
    p_target_total integer,
    p_min_fridge integer,
    p_target_fridge integer,
    p_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_name text;
    v_category text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is distinct from 'owner' then
        raise exception 'Apenas proprietários podem editar produtos.';
    end if;

    if not exists (
        select 1
        from public.guigs_products p
        where p.shop_id = p_shop_id
          and p.id = p_product_id
    ) then
        raise exception 'Produto não encontrado.';
    end if;

    v_name := trim(coalesce(p_name, ''));
    v_category := trim(coalesce(p_category, 'Outro'));

    if length(v_name) < 1 or length(v_name) > 160 then
        raise exception 'Nome do produto inválido.';
    end if;

    if p_min_total < 0
       or p_target_total < p_min_total
       or p_min_fridge < 0
       or p_target_fridge < p_min_fridge then
        raise exception 'Limites de estoque inválidos.';
    end if;

    if exists (
        select 1
        from public.guigs_products p
        where p.shop_id = p_shop_id
          and p.id <> p_product_id
          and lower(trim(p.name)) = lower(v_name)
    ) then
        raise exception 'Já existe outro produto com esse nome.';
    end if;

    update public.guigs_products
    set
        name = v_name,
        category = case
            when length(v_category) = 0 then 'Outro'
            else v_category
        end,
        min_total = p_min_total,
        target_total = p_target_total,
        min_fridge = p_min_fridge,
        target_fridge = p_target_fridge,
        active = p_active
    where shop_id = p_shop_id
      and id = p_product_id;

    return true;
end;
$$;


-- ============================================================
-- 4. RECEBIMENTO DE ESTOQUE
-- ============================================================

create or replace function public.guigs_receive_stock(
    p_shop_id uuid,
    p_product_id uuid,
    p_lot_code text,
    p_expiry date,
    p_quantity integer,
    p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_lot_id uuid;
    v_event_id uuid := gen_random_uuid();
    v_code text;
    v_note text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is null then
        raise exception 'Usuário sem vínculo ativo com a pizzaria.';
    end if;

    if p_quantity <= 0 then
        raise exception 'A quantidade recebida deve ser maior que zero.';
    end if;

    if p_expiry is null then
        raise exception 'A validade é obrigatória.';
    end if;

    if p_expiry < current_date then
        raise exception 'Não é permitido receber um lote já vencido.';
    end if;

    v_code := trim(coalesce(p_lot_code, ''));
    v_note := coalesce(p_note, '');

    if length(v_code) < 1 or length(v_code) > 120 then
        raise exception 'Código do lote inválido.';
    end if;

    if length(v_note) > 1000 then
        raise exception 'Observação excede 1000 caracteres.';
    end if;

    if not exists (
        select 1
        from public.guigs_products p
        where p.shop_id = p_shop_id
          and p.id = p_product_id
          and p.active = true
    ) then
        raise exception 'Produto inexistente ou inativo.';
    end if;

    insert into public.guigs_lots (
        shop_id,
        product_id,
        code,
        expiry
    )
    values (
        p_shop_id,
        p_product_id,
        v_code,
        p_expiry
    )
    on conflict (shop_id, product_id, code, expiry)
    do update
        set code = excluded.code
    returning id into v_lot_id;

    -- Serializa operações futuras deste lote.
    perform 1
    from public.guigs_lots
    where shop_id = p_shop_id
      and id = v_lot_id
    for update;

    insert into public.guigs_movements (
        shop_id,
        lot_id,
        event_id,
        movement_type,
        location,
        delta,
        actor_id,
        note
    )
    values (
        p_shop_id,
        v_lot_id,
        v_event_id,
        'receipt',
        'stock',
        p_quantity,
        auth.uid(),
        v_note
    );

    return jsonb_build_object(
        'success', true,
        'event_id', v_event_id,
        'lot_id', v_lot_id,
        'quantity', p_quantity,
        'location', 'stock'
    );
end;
$$;


-- ============================================================
-- 5. TRANSFERÊNCIA ESTOQUE <-> GELADEIRA
-- ============================================================

create or replace function public.guigs_transfer_stock(
    p_shop_id uuid,
    p_lot_id uuid,
    p_from_location text,
    p_to_location text,
    p_quantity integer,
    p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_balance integer;
    v_event_id uuid := gen_random_uuid();
    v_movement_type text;
    v_expiry date;
    v_note text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is null then
        raise exception 'Usuário sem vínculo ativo com a pizzaria.';
    end if;

    if p_quantity <= 0 then
        raise exception 'A quantidade deve ser maior que zero.';
    end if;

    if p_from_location not in ('stock', 'fridge')
       or p_to_location not in ('stock', 'fridge')
       or p_from_location = p_to_location then
        raise exception 'Transferência entre locais inválida.';
    end if;

    v_note := coalesce(p_note, '');

    if length(v_note) > 1000 then
        raise exception 'Observação excede 1000 caracteres.';
    end if;

    -- Bloqueia o lote para impedir duas movimentações simultâneas
    -- de utilizarem o mesmo saldo.
    select l.expiry
    into v_expiry
    from public.guigs_lots l
    where l.shop_id = p_shop_id
      and l.id = p_lot_id
    for update;

    if not found then
        raise exception 'Lote não encontrado.';
    end if;

    -- Não mandar lote vencido para a geladeira.
    if p_to_location = 'fridge'
       and v_expiry < current_date then
        raise exception 'Lotes vencidos não podem ser enviados para a geladeira.';
    end if;

    v_balance := guigs_private.lot_balance(
        p_shop_id,
        p_lot_id,
        p_from_location
    );

    if v_balance < p_quantity then
        raise exception
            'Saldo insuficiente. Disponível: %, solicitado: %.',
            v_balance,
            p_quantity;
    end if;

    if p_from_location = 'stock'
       and p_to_location = 'fridge' then
        v_movement_type := 'transfer';
    else
        v_movement_type := 'return';
    end if;

    -- Saída da origem.
    insert into public.guigs_movements (
        shop_id,
        lot_id,
        event_id,
        movement_type,
        location,
        delta,
        actor_id,
        note
    )
    values (
        p_shop_id,
        p_lot_id,
        v_event_id,
        v_movement_type,
        p_from_location,
        -p_quantity,
        auth.uid(),
        v_note
    );

    -- Entrada no destino.
    insert into public.guigs_movements (
        shop_id,
        lot_id,
        event_id,
        movement_type,
        location,
        delta,
        actor_id,
        note
    )
    values (
        p_shop_id,
        p_lot_id,
        v_event_id,
        v_movement_type,
        p_to_location,
        p_quantity,
        auth.uid(),
        v_note
    );

    return jsonb_build_object(
        'success', true,
        'event_id', v_event_id,
        'lot_id', p_lot_id,
        'quantity', p_quantity,
        'from', p_from_location,
        'to', p_to_location
    );
end;
$$;


-- ============================================================
-- 6. REGISTRO DE VENDA
-- ============================================================

create or replace function public.guigs_register_sale(
    p_shop_id uuid,
    p_lot_id uuid,
    p_quantity integer,
    p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_balance integer;
    v_event_id uuid := gen_random_uuid();
    v_expiry date;
    v_note text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is null then
        raise exception 'Usuário sem vínculo ativo com a pizzaria.';
    end if;

    if p_quantity <= 0 then
        raise exception 'A quantidade vendida deve ser maior que zero.';
    end if;

    v_note := coalesce(p_note, '');

    if length(v_note) > 1000 then
        raise exception 'Observação excede 1000 caracteres.';
    end if;

    select l.expiry
    into v_expiry
    from public.guigs_lots l
    where l.shop_id = p_shop_id
      and l.id = p_lot_id
    for update;

    if not found then
        raise exception 'Lote não encontrado.';
    end if;

    if v_expiry < current_date then
        raise exception 'Não é permitido registrar venda de lote vencido.';
    end if;

    v_balance := guigs_private.lot_balance(
        p_shop_id,
        p_lot_id,
        'fridge'
    );

    if v_balance < p_quantity then
        raise exception
            'Saldo insuficiente na geladeira. Disponível: %, solicitado: %.',
            v_balance,
            p_quantity;
    end if;

    insert into public.guigs_movements (
        shop_id,
        lot_id,
        event_id,
        movement_type,
        location,
        delta,
        actor_id,
        note
    )
    values (
        p_shop_id,
        p_lot_id,
        v_event_id,
        'sale',
        'fridge',
        -p_quantity,
        auth.uid(),
        v_note
    );

    return jsonb_build_object(
        'success', true,
        'event_id', v_event_id,
        'lot_id', p_lot_id,
        'quantity', p_quantity,
        'location', 'fridge'
    );
end;
$$;


-- ============================================================
-- 7. REGISTRO DE PERDA
-- ============================================================

create or replace function public.guigs_register_loss(
    p_shop_id uuid,
    p_lot_id uuid,
    p_location text,
    p_quantity integer,
    p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_balance integer;
    v_event_id uuid := gen_random_uuid();
    v_note text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is null then
        raise exception 'Usuário sem vínculo ativo com a pizzaria.';
    end if;

    if p_location not in ('stock', 'fridge') then
        raise exception 'Local inválido.';
    end if;

    if p_quantity <= 0 then
        raise exception 'A quantidade da perda deve ser maior que zero.';
    end if;

    v_note := coalesce(p_note, '');

    if length(v_note) > 1000 then
        raise exception 'Observação excede 1000 caracteres.';
    end if;

    perform 1
    from public.guigs_lots l
    where l.shop_id = p_shop_id
      and l.id = p_lot_id
    for update;

    if not found then
        raise exception 'Lote não encontrado.';
    end if;

    v_balance := guigs_private.lot_balance(
        p_shop_id,
        p_lot_id,
        p_location
    );

    if v_balance < p_quantity then
        raise exception
            'Saldo insuficiente. Disponível: %, solicitado: %.',
            v_balance,
            p_quantity;
    end if;

    insert into public.guigs_movements (
        shop_id,
        lot_id,
        event_id,
        movement_type,
        location,
        delta,
        actor_id,
        note
    )
    values (
        p_shop_id,
        p_lot_id,
        v_event_id,
        'loss',
        p_location,
        -p_quantity,
        auth.uid(),
        v_note
    );

    return jsonb_build_object(
        'success', true,
        'event_id', v_event_id,
        'lot_id', p_lot_id,
        'quantity', p_quantity,
        'location', p_location
    );
end;
$$;


-- ============================================================
-- 8. AJUSTE DE INVENTÁRIO
-- ============================================================
--
-- Diferente das demais operações, ajuste manual é restrito ao OWNER.
-- O usuário informa a quantidade física encontrada.
-- A função calcula a diferença automaticamente.
-- ============================================================

create or replace function public.guigs_adjust_stock(
    p_shop_id uuid,
    p_lot_id uuid,
    p_location text,
    p_new_quantity integer,
    p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
    v_current_balance integer;
    v_delta integer;
    v_event_id uuid := gen_random_uuid();
    v_note text;
begin
    if auth.uid() is null then
        raise exception 'Usuário não autenticado.';
    end if;

    v_role := guigs_private.member_role(p_shop_id);

    if v_role is distinct from 'owner' then
        raise exception 'Apenas proprietários podem realizar ajustes de inventário.';
    end if;

    if p_location not in ('stock', 'fridge') then
        raise exception 'Local inválido.';
    end if;

    if p_new_quantity < 0 then
        raise exception 'A quantidade física não pode ser negativa.';
    end if;

    v_note := coalesce(p_note, '');

    if length(v_note) > 1000 then
        raise exception 'Observação excede 1000 caracteres.';
    end if;

    perform 1
    from public.guigs_lots l
    where l.shop_id = p_shop_id
      and l.id = p_lot_id
    for update;

    if not found then
        raise exception 'Lote não encontrado.';
    end if;

    v_current_balance := guigs_private.lot_balance(
        p_shop_id,
        p_lot_id,
        p_location
    );

    v_delta := p_new_quantity - v_current_balance;

    if v_delta = 0 then
        return jsonb_build_object(
            'success', true,
            'changed', false,
            'lot_id', p_lot_id,
            'location', p_location,
            'quantity', p_new_quantity
        );
    end if;

    insert into public.guigs_movements (
        shop_id,
        lot_id,
        event_id,
        movement_type,
        location,
        delta,
        actor_id,
        note
    )
    values (
        p_shop_id,
        p_lot_id,
        v_event_id,
        'adjust',
        p_location,
        v_delta,
        auth.uid(),
        v_note
    );

    return jsonb_build_object(
        'success', true,
        'changed', true,
        'event_id', v_event_id,
        'lot_id', p_lot_id,
        'location', p_location,
        'old_quantity', v_current_balance,
        'new_quantity', p_new_quantity,
        'delta', v_delta
    );
end;
$$;


-- ============================================================
-- 9. PERMISSÕES DAS FUNÇÕES RPC
-- ============================================================

-- Remove execução pública por padrão.

revoke all on function public.guigs_create_product(
    uuid, text, text, integer, integer, integer, integer
) from public;

revoke all on function public.guigs_update_product(
    uuid, uuid, text, text, integer, integer, integer, integer, boolean
) from public;

revoke all on function public.guigs_receive_stock(
    uuid, uuid, text, date, integer, text
) from public;

revoke all on function public.guigs_transfer_stock(
    uuid, uuid, text, text, integer, text
) from public;

revoke all on function public.guigs_register_sale(
    uuid, uuid, integer, text
) from public;

revoke all on function public.guigs_register_loss(
    uuid, uuid, text, integer, text
) from public;

revoke all on function public.guigs_adjust_stock(
    uuid, uuid, text, integer, text
) from public;


-- Libera somente para usuários autenticados.

grant execute on function public.guigs_create_product(
    uuid, text, text, integer, integer, integer, integer
) to authenticated;

grant execute on function public.guigs_update_product(
    uuid, uuid, text, text, integer, integer, integer, integer, boolean
) to authenticated;

grant execute on function public.guigs_receive_stock(
    uuid, uuid, text, date, integer, text
) to authenticated;

grant execute on function public.guigs_transfer_stock(
    uuid, uuid, text, text, integer, text
) to authenticated;

grant execute on function public.guigs_register_sale(
    uuid, uuid, integer, text
) to authenticated;

grant execute on function public.guigs_register_loss(
    uuid, uuid, text, integer, text
) to authenticated;

grant execute on function public.guigs_adjust_stock(
    uuid, uuid, text, integer, text
) to authenticated;


commit;