-- GUIG'S STOCK 1.3
-- Escalabilidade do histórico e leitura eficiente de saldos.

begin;


-- ============================================================
-- ÍNDICE PARA CONSULTAS DE HISTÓRICO
-- ============================================================

create index if not exists guigs_movements_shop_created_idx
on public.guigs_movements (
  shop_id,
  created_at desc
);


-- ============================================================
-- SALDO ATUAL DOS LOTES
-- ============================================================
-- Evita que o navegador precise baixar todo o histórico
-- apenas para calcular estoque e geladeira.

create or replace function public.guigs_get_lot_balances(
  p_shop uuid
)
returns table (
  lot_id uuid,
  stock bigint,
  fridge bigint
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


  return query

  select
    l.id as lot_id,

    coalesce(
      sum(m.delta)
        filter (
          where m.location = 'stock'
        ),
      0
    )::bigint as stock,

    coalesce(
      sum(m.delta)
        filter (
          where m.location = 'fridge'
        ),
      0
    )::bigint as fridge

  from public.guigs_lots l

  left join public.guigs_movements m
    on m.shop_id = l.shop_id
    and m.lot_id = l.id

  where l.shop_id = p_shop

  group by l.id;

end;
$$;


revoke all
on function public.guigs_get_lot_balances(uuid)
from public;


grant execute
on function public.guigs_get_lot_balances(uuid)
to authenticated;


commit;