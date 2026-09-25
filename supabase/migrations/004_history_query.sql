-- GUIG'S STOCK 1.3
-- Histórico paginado e preparado para filtros.

begin;


create or replace function public.guigs_get_history(
  p_shop uuid,
  p_limit integer default 20,
  p_offset integer default 0,
  p_product uuid default null,
  p_type text default null,
  p_actor uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_search text default null
)
returns table (
  id uuid,
  lot_id uuid,
  event_id uuid,
  movement_type text,
  location text,
  delta integer,
  actor_id uuid,
  actor_email text,
  note text,
  created_at timestamptz,
  product_id uuid,
  product_name text,
  lot_code text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin

  if not guigs_private.is_member(p_shop) then
    raise exception 'Acesso negado.';
  end if;


  if p_limit < 1 or p_limit > 100 then
    raise exception 'Limite inválido.';
  end if;


  if p_offset < 0 then
    raise exception 'Offset inválido.';
  end if;


  if p_type is not null
     and p_type not in (
       'receipt',
       'transfer',
       'return',
       'sale',
       'loss',
       'adjust'
     ) then
    raise exception 'Tipo de movimentação inválido.';
  end if;


  return query

  select
    m.id,
    m.lot_id,
    m.event_id,
    m.movement_type,
    m.location,
    m.delta,
    m.actor_id,
    u.email::text as actor_email,
    m.note,
    m.created_at,
    p.id as product_id,
    p.name as product_name,
    l.code as lot_code,

    count(*) over() as total_count

  from public.guigs_movements m

  join public.guigs_lots l
    on l.shop_id = m.shop_id
    and l.id = m.lot_id

  join public.guigs_products p
    on p.shop_id = m.shop_id
    and p.id = l.product_id

  left join auth.users u
    on u.id = m.actor_id

  where m.shop_id = p_shop

    and (
      p_product is null
      or p.id = p_product
    )

    and (
      p_type is null
      or m.movement_type = p_type
    )

    and (
      p_actor is null
      or m.actor_id = p_actor
    )

    and (
      p_date_from is null
      or m.created_at >= p_date_from
    )

    and (
      p_date_to is null
      or m.created_at <= p_date_to
    )

    and (
      p_search is null
      or trim(p_search) = ''
      or p.name ilike '%' || trim(p_search) || '%'
      or l.code ilike '%' || trim(p_search) || '%'
      or m.note ilike '%' || trim(p_search) || '%'
    )

  order by
    m.created_at desc,
    m.id desc

  limit p_limit
  offset p_offset;

end;
$$;


revoke all
on function public.guigs_get_history(
  uuid,
  integer,
  integer,
  uuid,
  text,
  uuid,
  timestamptz,
  timestamptz,
  text
)
from public;


grant execute
on function public.guigs_get_history(
  uuid,
  integer,
  integer,
  uuid,
  text,
  uuid,
  timestamptz,
  timestamptz,
  text
)
to authenticated;


commit;