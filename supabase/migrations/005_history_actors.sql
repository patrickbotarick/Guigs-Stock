-- GUIG'S STOCK 1.3
-- Usuários disponíveis para filtro do histórico.

begin;


create or replace function public.guigs_get_history_actors(
  p_shop uuid
)
returns table (
  actor_id uuid,
  actor_email text
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

  select distinct
    m.actor_id,
    coalesce(
      u.email::text,
      'Usuário desconhecido'
    ) as actor_email

  from public.guigs_movements m

  left join auth.users u
    on u.id = m.actor_id

  where m.shop_id = p_shop

  order by actor_email;

end;
$$;


revoke all
on function public.guigs_get_history_actors(uuid)
from public;


grant execute
on function public.guigs_get_history_actors(uuid)
to authenticated;


commit;