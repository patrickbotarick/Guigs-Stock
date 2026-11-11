-- Configuração pendente usa NULL. Nenhuma linha existente é reescrita.
begin;
set local lock_timeout='5s';

alter table public.guigs_products
  alter column min_total drop not null, alter column min_total drop default,
  alter column target_total drop not null, alter column target_total drop default,
  alter column min_fridge drop not null, alter column min_fridge drop default,
  alter column target_fridge drop not null, alter column target_fridge drop default,
  add constraint guigs_product_targets_nonnegative check (target_total >= 0 and target_fridge >= 0);

alter table public.guigs_fridge_slots
  alter column min_quantity drop not null, alter column min_quantity drop default,
  alter column target_quantity drop not null, alter column target_quantity drop default,
  add constraint guigs_slot_nullable_thresholds
    check (target_quantity >= 0 and min_quantity <= capacity_quantity);

create or replace function public.guigs_create_product(
    p_shop_id uuid,
    p_name text,
    p_category text default 'Outro',
    p_min_total integer default null,
    p_target_total integer default null,
    p_min_fridge integer default null,
    p_target_fridge integer default null
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
       or p_target_total < 0 or p_target_total < p_min_total
       or p_min_fridge < 0
       or p_target_fridge < 0 or p_target_fridge < p_min_fridge then
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
       or p_target_total < 0 or p_target_total < p_min_total
       or p_min_fridge < 0
       or p_target_fridge < 0 or p_target_fridge < p_min_fridge then
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

create or replace function public.guigs_save_fridge_layout(p_shop_id uuid,p_kind text,p_values jsonb,p_id uuid default null,p_revision integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_name text; v_active boolean; v_order integer; v_fridge uuid; v_shelf uuid; v_product uuid;
  v_width numeric; v_start numeric; v_height numeric; v_min integer; v_target integer; v_capacity integer;
  v_result jsonb; v_current_product uuid; v_current_fridge uuid; v_current_shelf uuid;
begin
  perform guigs_private.spatial_stock_gate();
  if not guigs_private.can_manage_fridge_layout(p_shop_id) then
    raise exception 'Sem permissão para configurar geladeiras.';
  end if;
  if p_kind is null or p_kind not in ('fridge','shelf','slot') or jsonb_typeof(p_values) is distinct from 'object'
     or ((p_id is null) <> (p_revision is null)) then raise exception 'Layout inválido.'; end if;
  v_name:=btrim(p_values->>'name');
  v_active:=coalesce((p_values->>'active')::boolean,true);
  v_order:=coalesce((p_values->>'sort_order')::integer,0);
  if p_kind='fridge' then
    v_width:=coalesce((p_values->>'width_ratio')::numeric,1);
    if p_id is null then
      insert into public.guigs_fridges as f(shop_id,name,active,sort_order,width_ratio)
        values(p_shop_id,v_name,v_active,v_order,v_width) returning to_jsonb(f) into v_result;
    else
      if not v_active and exists(select 1 from public.guigs_movements m join public.guigs_fridge_slots x
        on (x.shop_id,x.id)=(m.shop_id,m.slot_id) where m.shop_id=p_shop_id and x.fridge_id=p_id
        group by m.slot_id,m.lot_id having sum(m.delta)<>0) then raise exception 'Geladeira com saldo: realoque antes de desativar.'; end if;
      update public.guigs_fridges f set name=v_name,active=v_active,sort_order=v_order,width_ratio=v_width,revision=f.revision+1
        where f.shop_id=p_shop_id and f.id=p_id and f.revision=p_revision returning to_jsonb(f) into v_result;
    end if;
  elsif p_kind='shelf' then
    v_fridge:=(p_values->>'fridge_id')::uuid;
    v_start:=coalesce((p_values->>'y_ratio')::numeric,0);
    v_height:=coalesce((p_values->>'height_ratio')::numeric,1);
    if p_id is null then
      insert into public.guigs_fridge_shelves as h(shop_id,fridge_id,name,active,sort_order,y_ratio,height_ratio)
        values(p_shop_id,v_fridge,v_name,v_active,v_order,v_start,v_height) returning to_jsonb(h) into v_result;
    else
      if not v_active and exists(select 1 from public.guigs_movements m join public.guigs_fridge_slots x
        on (x.shop_id,x.id)=(m.shop_id,m.slot_id) where m.shop_id=p_shop_id and x.shelf_id=p_id
        group by m.slot_id,m.lot_id having sum(m.delta)<>0) then raise exception 'Prateleira com saldo: realoque antes de desativar.'; end if;
      update public.guigs_fridge_shelves h set name=v_name,active=v_active,sort_order=v_order,y_ratio=v_start,
        height_ratio=v_height,revision=h.revision+1 where h.shop_id=p_shop_id and h.id=p_id and h.revision=p_revision
        returning to_jsonb(h) into v_result;
    end if;
  else
    v_fridge:=(p_values->>'fridge_id')::uuid; v_shelf:=(p_values->>'shelf_id')::uuid;
    v_product:=(p_values->>'product_id')::uuid; v_start:=coalesce((p_values->>'x_ratio')::numeric,0);
    v_width:=coalesce((p_values->>'width_ratio')::numeric,1);
    v_min:=(p_values->>'min_quantity')::integer;
    v_target:=(p_values->>'target_quantity')::integer;
    if p_values->>'capacity_quantity' is not null
       and (p_values->>'capacity_quantity') !~ '^[1-9][0-9]{0,6}$' then
      raise exception 'Informe uma capacidade inteira positiva ou deixe em branco.';
    end if;
    v_capacity:=(p_values->>'capacity_quantity')::integer;
    if v_capacity>1000000 then raise exception 'A capacidade máxima é de 1000000 unidades.'; end if;
    if p_id is not null then
      select x.product_id,x.fridge_id,x.shelf_id,
        case when p_values ? 'min_quantity' then v_min else x.min_quantity end,
        case when p_values ? 'target_quantity' then v_target else x.target_quantity end
      into v_current_product,v_current_fridge,v_current_shelf,v_min,v_target
      from public.guigs_fridge_slots x where x.shop_id=p_shop_id and x.id=p_id and x.revision=p_revision;
      if not found then raise exception 'Layout alterado ou indisponível. Atualize o mapa.'; end if;
    end if;
    if v_product is not null and not exists(select 1 from public.guigs_products p
      where p.shop_id=p_shop_id and p.id=v_product and (p.active or p.id=v_current_product)) then
      raise exception 'Produto indisponível nesta loja.';
    end if;
    if p_id is null then
      insert into public.guigs_fridge_slots as x(shop_id,fridge_id,shelf_id,product_id,name,active,sort_order,
        x_ratio,width_ratio,min_quantity,target_quantity,capacity_quantity)
        values(p_shop_id,v_fridge,v_shelf,v_product,v_name,v_active,v_order,v_start,v_width,v_min,v_target,v_capacity)
        returning to_jsonb(x) into v_result;
    else
      if exists(select 1 from public.guigs_movements m join public.guigs_lots l
        on (l.shop_id,l.id)=(m.shop_id,m.lot_id) where m.shop_id=p_shop_id and m.slot_id=p_id
        group by m.lot_id,l.product_id having sum(m.delta)<>0 and (not v_active or l.product_id is distinct from v_product or v_current_fridge is distinct from v_fridge or v_current_shelf is distinct from v_shelf))
        or (select coalesce(sum(delta),0) from public.guigs_movements where shop_id=p_shop_id and slot_id=p_id)>coalesce(v_capacity,0) then
        raise exception 'Posição com saldo incompatível. Realocar estoque antes de alterar.';
      end if;
      update public.guigs_fridge_slots x set fridge_id=v_fridge,shelf_id=v_shelf,product_id=v_product,name=v_name,active=v_active,sort_order=v_order,
        x_ratio=v_start,width_ratio=v_width,min_quantity=v_min,target_quantity=v_target,capacity_quantity=v_capacity,revision=x.revision+1
        where x.shop_id=p_shop_id and x.id=p_id and x.revision=p_revision returning to_jsonb(x) into v_result;
    end if;
  end if;
  if v_result is null then raise exception 'Layout alterado ou indisponível. Atualize o mapa.'; end if;
  return v_result;
end $$;

create or replace function public.guigs_get_fridge_replenishment(p_shop_id uuid,p_slot_id uuid,p_quantity integer default null)
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
  if s.capacity_quantity is null then
    raise exception 'Defina a capacidade do slot antes de repor estoque.';
  end if;
  if s.target_quantity is null then
    raise exception 'Defina a meta do slot antes de repor estoque.';
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

commit;
