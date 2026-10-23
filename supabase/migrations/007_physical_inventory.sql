-- v1.6C: PREPARADA, NÃO aplicar em produção nesta fase.
-- Aditiva: não substitui nenhuma função/policy/tabela anterior.
begin;

create table public.guigs_inventories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.guigs_shops(id),
  status text not null default 'open' check (status in ('open','review','completed','cancelled')),
  version integer not null default 1,
  started_at timestamptz not null default clock_timestamp(),
  started_by uuid not null references auth.users(id),
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  observation text not null default '' check (length(observation) <= 1000),
  start_movement_count bigint not null,
  unique(shop_id,id)
);
create unique index guigs_inventory_one_active on public.guigs_inventories(shop_id)
  where status in ('open','review');

create table public.guigs_inventory_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  inventory_id uuid not null,
  lot_id uuid not null,
  product_id uuid not null,
  product_name text not null,
  lot_code text not null,
  expiry date not null,
  supplier_name text,
  location text not null check (location in ('stock','fridge')),
  expected_initial bigint not null check (expected_initial between 0 and 2147483647),
  initial_movement_count bigint not null,
  snapshot_at timestamptz not null default clock_timestamp(),
  basis_quantity bigint not null check (basis_quantity between 0 and 2147483647),
  basis_movement_count bigint not null,
  counted_quantity integer check (counted_quantity >= 0),
  counted_by uuid references auth.users(id),
  counted_at timestamptz,
  version integer not null default 1,
  applied_delta integer,
  adjustment_event_id uuid,
  foreign key (shop_id,inventory_id) references public.guigs_inventories(shop_id,id),
  foreign key (shop_id,lot_id) references public.guigs_lots(shop_id,id),
  foreign key (shop_id,product_id) references public.guigs_products(shop_id,id),
  unique(inventory_id,lot_id,location),
  unique(shop_id,inventory_id,id)
);
create index guigs_inventory_items_shop on public.guigs_inventory_items(shop_id,inventory_id);

create table public.guigs_inventory_audit (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  inventory_id uuid not null,
  item_id uuid,
  action text not null check (action in ('created','counted','recount','scope_refreshed','review','reopened','completed','cancelled')),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  previous_quantity integer,
  counted_quantity integer,
  basis_quantity bigint,
  note text not null default '' check (length(note) <= 1000),
  foreign key(shop_id,inventory_id) references public.guigs_inventories(shop_id,id),
  foreign key(shop_id,inventory_id,item_id) references public.guigs_inventory_items(shop_id,inventory_id,id)
);
create index guigs_inventory_audit_shop on public.guigs_inventory_audit(shop_id,inventory_id,created_at);
create index guigs_inventories_shop_date on public.guigs_inventories(shop_id,started_at desc,id);

alter table public.guigs_inventories enable row level security;
alter table public.guigs_inventory_items enable row level security;
alter table public.guigs_inventory_audit enable row level security;
revoke all on public.guigs_inventories,public.guigs_inventory_items,public.guigs_inventory_audit from public,anon,authenticated;
grant select on public.guigs_inventories,public.guigs_inventory_items,public.guigs_inventory_audit to authenticated;
create policy guigs_inventories_read on public.guigs_inventories for select to authenticated using(guigs_private.is_member(shop_id));
create policy guigs_inventory_items_read on public.guigs_inventory_items for select to authenticated using(guigs_private.is_member(shop_id));
create policy guigs_inventory_audit_read on public.guigs_inventory_audit for select to authenticated using(guigs_private.is_member(shop_id));

-- Helpers privados sem execução concedida ao cliente.
create function guigs_private.inventory_lock(p_shop uuid,p_inventory uuid,p_owner boolean)
returns public.guigs_inventories language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories;
begin
  if guigs_private.member_role(p_shop) is null then raise exception 'Acesso negado.'; end if;
  if p_owner and guigs_private.member_role(p_shop) is distinct from 'owner' then raise exception 'Apenas proprietários podem administrar inventário.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop and id=p_inventory for update;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  if v.status in ('completed','cancelled') then raise exception 'Inventário encerrado: somente leitura.'; end if;
  return v;
end $$;
revoke all on function guigs_private.inventory_lock(uuid,uuid,boolean) from public,anon,authenticated;

create function guigs_private.inventory_add_items(p_shop uuid,p_inventory uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_added integer;
begin
  insert into public.guigs_inventory_items(shop_id,inventory_id,lot_id,product_id,product_name,lot_code,expiry,supplier_name,
    location,expected_initial,initial_movement_count,basis_quantity,basis_movement_count)
  select p_shop,p_inventory,l.id,p.id,p.name,l.code,l.expiry,s.name,x.location,
    coalesce(sum(m.delta),0),count(m.id),coalesce(sum(m.delta),0),count(m.id)
  from public.guigs_lots l join public.guigs_products p on p.shop_id=l.shop_id and p.id=l.product_id
  left join public.guigs_suppliers s on s.shop_id=l.shop_id and s.id=l.supplier_id
  cross join (values('stock'::text),('fridge'::text)) x(location)
  left join public.guigs_movements m on m.shop_id=l.shop_id and m.lot_id=l.id and m.location=x.location
  where l.shop_id=p_shop and (p.active or exists(select 1 from public.guigs_movements b
    where b.shop_id=l.shop_id and b.lot_id=l.id group by b.location having sum(b.delta)>0))
  group by l.id,p.id,s.id,x.location
  on conflict(inventory_id,lot_id,location) do nothing;
  get diagnostics v_added=row_count;
  return v_added;
end $$;
revoke all on function guigs_private.inventory_add_items(uuid,uuid) from public,anon,authenticated;

create function public.guigs_create_inventory(p_shop_id uuid,p_observation text default '')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_count bigint;
begin
  if guigs_private.member_role(p_shop_id) is distinct from 'owner' then raise exception 'Apenas proprietários podem criar inventário.'; end if;
  if length(coalesce(p_observation,''))>1000 then raise exception 'Observação excede 1000 caracteres.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para capturar o inventário.'; end if;
  -- Curto gate atômico de escopo: NOWAIT falha se houver operação em andamento.
  -- EXCLUSIVE conflita com INSERT/UPSERT e SELECT FOR UPDATE das RPCs legadas.
  lock table public.guigs_lots in exclusive mode nowait;
  select count(*) into v_count from public.guigs_movements where shop_id=p_shop_id;
  insert into public.guigs_inventories(shop_id,started_by,observation,start_movement_count)
    values(p_shop_id,auth.uid(),coalesce(p_observation,''),v_count) returning id into v_id;
  perform guigs_private.inventory_add_items(p_shop_id,v_id);
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id) values(p_shop_id,v_id,'created',auth.uid());
  return v_id;
exception when unique_violation then raise exception 'Já existe inventário aberto ou em revisão nesta loja.';
end $$;

create function public.guigs_list_inventories(p_shop_id uuid,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'Página inválida.'; end if;
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into v_rows from (
    select v.*, (select email from auth.users where id=v.started_by) as started_by_label,
      (select email from auth.users where id=v.completed_by) as completed_by_label,
      (select count(*) from public.guigs_inventory_items i where i.inventory_id=v.id) as item_count,
      (select count(*) from public.guigs_inventory_items i where i.inventory_id=v.id and i.counted_quantity is not null) as counted_count,
      (select count(*) from public.guigs_inventory_items i where i.inventory_id=v.id and i.counted_quantity<>i.basis_quantity) as divergent_count
    from public.guigs_inventories v where v.shop_id=p_shop_id order by v.started_at desc,v.id limit p_limit offset p_offset
  ) q;
  return jsonb_build_object('inventories',v_rows,'total',(select count(*) from public.guigs_inventories where shop_id=p_shop_id),
    'last_completed',(select to_jsonb(c)||jsonb_build_object('completed_by_label',(select email from auth.users where id=c.completed_by)) from public.guigs_inventories c where c.shop_id=p_shop_id and c.status='completed' order by c.completed_at desc,c.id limit 1));
end $$;

create function public.guigs_get_inventory(p_shop_id uuid,p_inventory_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v public.guigs_inventories; v_items jsonb; v_audit jsonb; v_new integer;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select * into v from public.guigs_inventories where shop_id=p_shop_id and id=p_inventory_id;
  if not found then raise exception 'Inventário não encontrado.'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.product_name,q.expiry,q.lot_id,q.location),'[]'::jsonb) into v_items from (
    select i.*, (select email from auth.users where id=i.counted_by) as counted_by_label,
      coalesce(sum(m.delta),0) as current_quantity,count(m.id) as current_movement_count,
      (count(m.id)<>i.basis_movement_count or coalesce(sum(m.delta),0)<>i.basis_quantity) as conflict
    from public.guigs_inventory_items i left join public.guigs_movements m
      on m.shop_id=i.shop_id and m.lot_id=i.lot_id and m.location=i.location
    where i.inventory_id=v.id group by i.id
  ) q;
  select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_label',(select email from auth.users where id=a.actor_id)) order by a.created_at,a.id),'[]'::jsonb) into v_audit from public.guigs_inventory_audit a where a.inventory_id=v.id;
  select count(*) into v_new from public.guigs_lots l join public.guigs_products p on p.id=l.product_id and p.shop_id=l.shop_id
    where l.shop_id=p_shop_id and (p.active or exists(select 1 from public.guigs_movements b where b.shop_id=l.shop_id and b.lot_id=l.id group by b.location having sum(b.delta)>0))
    and not exists(select 1 from public.guigs_inventory_items i where i.inventory_id=v.id and i.lot_id=l.id);
  return jsonb_build_object('inventory',to_jsonb(v)||jsonb_build_object('started_by_label',(select email from auth.users where id=v.started_by),'completed_by_label',(select email from auth.users where id=v.completed_by)),'items',v_items,'audit',v_audit,'new_lots',v_new,
    'movements_after_start',greatest(0,(select count(*) from public.guigs_movements where shop_id=p_shop_id)-v.start_movement_count));
end $$;

create function public.guigs_count_inventory_item(p_shop_id uuid,p_inventory_id uuid,p_item_id uuid,p_quantity integer,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; i public.guigs_inventory_items;
begin
  v:=guigs_private.inventory_lock(p_shop_id,p_inventory_id,false);
  if v.status<>'open' then raise exception 'Reabra o inventário para contar.'; end if;
  if p_quantity is null or p_quantity<0 then raise exception 'Contagem inválida.'; end if;
  select * into i from public.guigs_inventory_items where shop_id=p_shop_id and inventory_id=v.id and id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  if p_version is distinct from i.version then raise exception 'Item alterado por outra pessoa. Atualize antes de salvar.'; end if;
  if i.counted_quantity is not null then raise exception 'Use Recontar para preservar a evidência anterior.'; end if;
  update public.guigs_inventory_items set counted_quantity=p_quantity,counted_by=auth.uid(),counted_at=clock_timestamp(),version=version+1 where id=i.id;
  update public.guigs_inventories set version=version+1 where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,item_id,action,actor_id,counted_quantity,basis_quantity)
    values(p_shop_id,v.id,i.id,'counted',auth.uid(),p_quantity,i.basis_quantity);
  return true;
end $$;

create function public.guigs_recount_inventory_item(p_shop_id uuid,p_inventory_id uuid,p_item_id uuid,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; i public.guigs_inventory_items; v_qty bigint; v_count bigint;
begin
  v:=guigs_private.inventory_lock(p_shop_id,p_inventory_id,false);
  if v.status<>'open' then raise exception 'Reabra o inventário para recontar.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para recontar.'; end if;
  select * into i from public.guigs_inventory_items where shop_id=p_shop_id and inventory_id=v.id and id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  if p_version is distinct from i.version then raise exception 'Item alterado por outra pessoa. Atualize antes de recontar.'; end if;
  perform 1 from public.guigs_lots where shop_id=p_shop_id and id=i.lot_id for update;
  select coalesce(sum(delta),0),count(*) into v_qty,v_count from public.guigs_movements where shop_id=p_shop_id and lot_id=i.lot_id and location=i.location;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,item_id,action,actor_id,previous_quantity,basis_quantity)
    values(p_shop_id,v.id,i.id,'recount',auth.uid(),i.counted_quantity,v_qty);
  update public.guigs_inventory_items set counted_quantity=null,counted_by=null,counted_at=null,
    basis_quantity=v_qty,basis_movement_count=v_count,version=version+1 where id=i.id;
  update public.guigs_inventories set version=version+1 where id=v.id;
  return true;
end $$;

create function public.guigs_refresh_inventory_scope(p_shop_id uuid,p_inventory_id uuid,p_version integer)
returns integer language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; v_added integer;
begin
  v:=guigs_private.inventory_lock(p_shop_id,p_inventory_id,true);
  if v.status<>'open' or p_version is distinct from v.version then raise exception 'Atualize e abra o inventário antes de incluir lotes.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para incluir lotes.'; end if;
  lock table public.guigs_lots in exclusive mode nowait;
  v_added:=guigs_private.inventory_add_items(p_shop_id,v.id);
  update public.guigs_inventories set version=version+1 where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id,note) values(p_shop_id,v.id,'scope_refreshed',auth.uid(),'Itens novos: '||v_added);
  return v_added;
end $$;

create function public.guigs_set_inventory_status(p_shop_id uuid,p_inventory_id uuid,p_status text,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories;
begin
  v:=guigs_private.inventory_lock(p_shop_id,p_inventory_id,true);
  if p_version is distinct from v.version then raise exception 'Inventário alterado. Atualize antes de continuar.'; end if;
  if p_status is null or not ((v.status='open' and p_status='review') or (v.status='review' and p_status='open') or p_status='cancelled') then
    raise exception 'Transição de inventário inválida.';
  end if;
  update public.guigs_inventories set status=p_status,version=version+1,
    cancelled_at=case when p_status='cancelled' then clock_timestamp() else null end,
    cancelled_by=case when p_status='cancelled' then auth.uid() else null end where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id)
    values(p_shop_id,v.id,case p_status when 'open' then 'reopened' when 'review' then 'review' else 'cancelled' end,auth.uid());
  return true;
end $$;

create function public.guigs_complete_inventory(p_shop_id uuid,p_inventory_id uuid,p_version integer,p_confirm boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.guigs_inventories; i public.guigs_inventory_items; v_count bigint; v_qty bigint; v_adjusted integer:=0; v_result jsonb;
begin
  v:=guigs_private.inventory_lock(p_shop_id,p_inventory_id,true);
  if v.status<>'review' or p_confirm is distinct from true then raise exception 'Revise e confirme explicitamente o fechamento.'; end if;
  if p_version is distinct from v.version then raise exception 'Revisão desatualizada. Atualize o inventário.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use isolamento READ COMMITTED para finalizar.'; end if;
  lock table public.guigs_lots in exclusive mode nowait;
  if exists(select 1 from public.guigs_lots l join public.guigs_products p on p.shop_id=l.shop_id and p.id=l.product_id
    where l.shop_id=p_shop_id and (p.active or exists(select 1 from public.guigs_movements m where m.shop_id=l.shop_id and m.lot_id=l.id group by m.location having sum(m.delta)>0))
    and not exists(select 1 from public.guigs_inventory_items x where x.inventory_id=v.id and x.lot_id=l.id)) then
    raise exception 'Há lotes novos. Reabra e inclua os lotes antes de finalizar.';
  end if;
  if not exists(select 1 from public.guigs_inventory_items where inventory_id=v.id) then raise exception 'Inventário sem itens.'; end if;
  -- Valida TODOS os itens antes de qualquer ajuste. Uma exceção reverte a RPC inteira.
  for i in select * from public.guigs_inventory_items where inventory_id=v.id order by lot_id,location loop
    if i.counted_quantity is null then raise exception 'Existem itens não contados.'; end if;
    select count(*),coalesce(sum(delta),0) into v_count,v_qty from public.guigs_movements where shop_id=p_shop_id and lot_id=i.lot_id and location=i.location;
    if v_count<>i.basis_movement_count or v_qty<>i.basis_quantity then raise exception 'Movimentações posteriores: reabra e reconte os itens afetados.'; end if;
  end loop;
  for i in select * from public.guigs_inventory_items where inventory_id=v.id order by lot_id,location loop
    if i.counted_quantity<>i.basis_quantity then
      v_result:=public.guigs_adjust_stock(p_shop_id,i.lot_id,i.location,i.counted_quantity,'Ajuste por inventário #'||v.id::text);
      update public.guigs_inventory_items set applied_delta=(v_result->>'delta')::integer,adjustment_event_id=(v_result->>'event_id')::uuid where id=i.id;
      v_adjusted:=v_adjusted+1;
    else update public.guigs_inventory_items set applied_delta=0 where id=i.id;
    end if;
  end loop;
  update public.guigs_inventories set status='completed',completed_at=clock_timestamp(),completed_by=auth.uid(),version=version+1 where id=v.id;
  insert into public.guigs_inventory_audit(shop_id,inventory_id,action,actor_id,note) values(p_shop_id,v.id,'completed',auth.uid(),'Ajustes: '||v_adjusted);
  return jsonb_build_object('inventory_id',v.id,'adjustments',v_adjusted);
end $$;

revoke all on function public.guigs_create_inventory(uuid,text),public.guigs_list_inventories(uuid,integer,integer),
 public.guigs_get_inventory(uuid,uuid),public.guigs_count_inventory_item(uuid,uuid,uuid,integer,integer),
 public.guigs_recount_inventory_item(uuid,uuid,uuid,integer),public.guigs_refresh_inventory_scope(uuid,uuid,integer),
 public.guigs_set_inventory_status(uuid,uuid,text,integer),public.guigs_complete_inventory(uuid,uuid,integer,boolean) from public,anon;
grant execute on function public.guigs_create_inventory(uuid,text),public.guigs_list_inventories(uuid,integer,integer),
 public.guigs_get_inventory(uuid,uuid),public.guigs_count_inventory_item(uuid,uuid,uuid,integer,integer),
 public.guigs_recount_inventory_item(uuid,uuid,uuid,integer),public.guigs_refresh_inventory_scope(uuid,uuid,integer),
 public.guigs_set_inventory_status(uuid,uuid,text,integer),public.guigs_complete_inventory(uuid,uuid,integer,boolean) to authenticated;

commit;
