begin;
set local lock_timeout='5s';

create table public.guigs_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.guigs_shops(id),
  status text not null default 'draft' check (status in ('draft','pending','ordered','received','cancelled')),
  note text not null default '' check (length(note)<=1000),
  version integer not null default 1 check (version>0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(shop_id,id)
);
create index guigs_purchase_orders_shop_created on public.guigs_purchase_orders(shop_id,created_at desc,id);

create table public.guigs_purchase_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  product_name text not null,
  original_suggestion integer check (original_suggestion>=0),
  quantity integer not null check (quantity>0),
  source text not null check (source in ('manual','suggestion')),
  supplier_id uuid,
  supplier_name text,
  note text not null default '' check (length(note)<=1000),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(shop_id,order_id,product_id),
  foreign key(shop_id,order_id) references public.guigs_purchase_orders(shop_id,id),
  foreign key(shop_id,product_id) references public.guigs_products(shop_id,id),
  foreign key(shop_id,supplier_id) references public.guigs_suppliers(shop_id,id),
  check ((supplier_id is null)=(supplier_name is null))
);
create index guigs_purchase_items_shop_product on public.guigs_purchase_items(shop_id,product_id,order_id);

create table public.guigs_purchase_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  order_id uuid not null,
  actor_id uuid not null references auth.users(id),
  action text not null check (action in ('created','items_updated','pending','ordered','received','cancelled')),
  previous jsonb,
  current jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(shop_id,order_id) references public.guigs_purchase_orders(shop_id,id)
);
create index guigs_purchase_events_order on public.guigs_purchase_events(shop_id,order_id,created_at desc,id);

create table guigs_private.purchase_commands (
  shop_id uuid not null references public.guigs_shops(id),
  request_id uuid not null,
  actor_id uuid not null references auth.users(id),
  payload jsonb not null,
  result jsonb not null,
  primary key(shop_id,request_id)
);
alter table guigs_private.purchase_commands enable row level security;
revoke all on guigs_private.purchase_commands from public,anon,authenticated;
alter table public.guigs_purchase_orders enable row level security;
alter table public.guigs_purchase_items enable row level security;
alter table public.guigs_purchase_events enable row level security;
revoke all on public.guigs_purchase_orders,public.guigs_purchase_items,public.guigs_purchase_events from public,anon,authenticated;
grant select on public.guigs_purchase_orders,public.guigs_purchase_items,public.guigs_purchase_events to authenticated;
create policy purchase_orders_read on public.guigs_purchase_orders for select to authenticated using (guigs_private.is_member(shop_id));
create policy purchase_items_read on public.guigs_purchase_items for select to authenticated using (guigs_private.is_member(shop_id));
create policy purchase_events_read on public.guigs_purchase_events for select to authenticated using (guigs_private.is_member(shop_id));

create function public.guigs_shopping_needs(p_shop_id uuid)
returns table(product_id uuid,product_name text,image_path text,min_total integer,target_total integer,
  dry bigint,unallocated bigint,slots bigint,available bigint,expired bigint,near_expiry bigint,
  base_suggested bigint,on_order bigint,suggested bigint)
language plpgsql stable security invoker set search_path='' as $$
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  return query
  with stock as (
    select l.product_id,
      sum(m.delta) filter(where l.expiry>=current_date and m.location='stock') as dry,
      sum(m.delta) filter(where l.expiry>=current_date and m.location='fridge' and m.slot_id is null) as unallocated,
      sum(m.delta) filter(where l.expiry>=current_date and m.slot_id is not null) as slots,
      sum(m.delta) filter(where l.expiry<current_date) as expired,
      sum(m.delta) filter(where l.expiry between current_date and current_date+30) as near_expiry
    from public.guigs_lots l join public.guigs_movements m on (m.shop_id,m.lot_id)=(l.shop_id,l.id)
    where l.shop_id=p_shop_id group by l.product_id
  ), committed as (
    select i.product_id,sum(i.quantity) as quantity from public.guigs_purchase_items i
    join public.guigs_purchase_orders o on (o.shop_id,o.id)=(i.shop_id,i.order_id)
    where i.shop_id=p_shop_id and o.status in ('pending','ordered') group by i.product_id
  ), positions as (
    select p.id,p.name,p.image_path,p.min_total,p.target_total,coalesce(s.dry,0) as dry,
      coalesce(s.unallocated,0) as unallocated,coalesce(s.slots,0) as slots,coalesce(s.expired,0) as expired,
      coalesce(s.near_expiry,0) as near_expiry,coalesce(c.quantity,0) as on_order
    from public.guigs_products p left join stock s on s.product_id=p.id left join committed c on c.product_id=p.id
    where p.shop_id=p_shop_id and p.active
  ), totals as (
    select q.*,q.dry+q.unallocated+q.slots as available from positions q
  ), demand as (
    select t.*,case when t.min_total is null or t.target_total is null then null
      when t.available<t.min_total then greatest(0,t.target_total-t.available) else 0 end as base
    from totals t
  )
  select d.id,d.name,d.image_path,d.min_total,d.target_total,d.dry,d.unallocated,d.slots,d.available,d.expired,
    d.near_expiry,d.base,d.on_order,case when d.base is null then null else greatest(0,d.base-d.on_order) end
  from demand d order by d.name,d.id;
end $$;

create function public.guigs_get_shopping_board(p_shop_id uuid,p_limit integer default 30,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'Página inválida.'; end if;
  return jsonb_build_object(
    'shop_name',(select name from public.guigs_shops where id=p_shop_id),
    'needs',(select coalesce(jsonb_agg(to_jsonb(n)),'[]') from public.guigs_shopping_needs(p_shop_id) n),
    'suppliers',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name,s.id),'[]')
      from public.guigs_suppliers s where s.shop_id=p_shop_id and s.active),
    'orders',(select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc,o.id),'[]') from
      (select * from public.guigs_purchase_orders where shop_id=p_shop_id order by created_at desc,id limit p_limit offset p_offset) o),
    'order_counts',(select jsonb_build_object('total',count(*),'in_progress',count(*) filter(where status in ('draft','pending')),
      'awaiting',count(*) filter(where status='ordered')) from public.guigs_purchase_orders where shop_id=p_shop_id));
end $$;

create function public.guigs_get_purchase_order(p_shop_id uuid,p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare header public.guigs_purchase_orders;
begin
  if not guigs_private.is_member(p_shop_id) then raise exception 'Acesso negado.'; end if;
  select * into header from public.guigs_purchase_orders where shop_id=p_shop_id and id=p_order_id;
  if not found then raise exception 'Lista não encontrada.'; end if;
  return jsonb_build_object('order',to_jsonb(header)||jsonb_build_object('created_by_label',
      (select email from auth.users where id=header.created_by)),
    'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.supplier_name nulls last,i.product_name,i.id),'[]')
      from public.guigs_purchase_items i where i.shop_id=p_shop_id and i.order_id=p_order_id),
    'events',(select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('actor_label',
      (select email from auth.users where id=e.actor_id)) order by e.created_at desc,e.id),'[]')
      from public.guigs_purchase_events e where e.shop_id=p_shop_id and e.order_id=p_order_id));
end $$;

create function public.guigs_apply_shopping_command(p_shop_id uuid,p_request_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  member_role text:=guigs_private.member_role(p_shop_id);
  actor uuid:=auth.uid();
  command jsonb:=jsonb_build_object('action',p_action,'payload',p_payload);
  replay guigs_private.purchase_commands;
  header public.guigs_purchase_orders;
  old_item public.guigs_purchase_items;
  product public.guigs_products;
  item record;
  suggestions jsonb;
  suggestion integer;
  supplier_label text;
  order_key uuid:=(p_payload->>'order_id')::uuid;
  expected_version integer:=(p_payload->>'version')::integer;
  next_status text:=p_payload->>'status';
  order_note text:=btrim(coalesce(p_payload->>'note',''));
  minimum integer;
  target integer;
  before_state jsonb;
  after_state jsonb;
  event_action text;
  result jsonb;
begin
  if actor is null or member_role is null then raise exception 'Acesso negado.'; end if;
  if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object'
     or p_action is null or p_action not in ('save','status','limits') then raise exception 'Comando inválido.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Use READ COMMITTED para compras.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('guigs:purchases:'||p_shop_id,0));
  select * into replay from guigs_private.purchase_commands where shop_id=p_shop_id and request_id=p_request_id;
  if found then
    if replay.actor_id is distinct from actor or replay.payload is distinct from command then
      raise exception 'Identificador já utilizado para outra operação.';
    end if;
    return replay.result;
  end if;

  if p_action='limits' then
    if member_role<>'owner' then raise exception 'Somente proprietários podem editar parâmetros.'; end if;
    if not (p_payload ?& array['min_total','target_total','expected']) then raise exception 'Informe mínimo e meta, ou deixe em branco.'; end if;
    minimum:=(p_payload->>'min_total')::integer;
    target:=(p_payload->>'target_total')::integer;
    if minimum<0 or target<0 or target<minimum then raise exception 'Meta deve ser maior ou igual ao mínimo; use inteiros não negativos.'; end if;
    select * into product from public.guigs_products where shop_id=p_shop_id and id=(p_payload->>'product_id')::uuid for update;
    if not found then raise exception 'Produto não encontrado.'; end if;
    if p_payload->'expected' is distinct from jsonb_build_object('min_total',product.min_total,'target_total',product.target_total) then
      raise exception 'Os parâmetros mudaram. Atualize a lista antes de salvar.';
    end if;
    update public.guigs_products set min_total=minimum,target_total=target where shop_id=p_shop_id and id=product.id;
    result:=jsonb_build_object('product_id',product.id,'min_total',minimum,'target_total',target);
  else
    if order_key is not null then
      select * into header from public.guigs_purchase_orders where shop_id=p_shop_id and id=order_key for update;
      if not found then raise exception 'Lista não encontrada.'; end if;
      if member_role<>'owner' and (header.created_by<>actor or header.status<>'draft') then raise exception 'Acesso negado a esta alteração.'; end if;
      if header.version is distinct from expected_version then raise exception 'A lista foi alterada. Atualize antes de salvar.'; end if;
      before_state:=public.guigs_get_purchase_order(p_shop_id,order_key)-'events';
    end if;

    if p_action='save' then
      if length(order_note)>1000 or jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'Lista inválida.'; end if;
      if jsonb_array_length(p_payload->'items')>200 or exists(
        select 1 from jsonb_to_recordset(p_payload->'items') as x(product_id uuid) group by x.product_id having count(*)>1)
      then raise exception 'Use até 200 produtos distintos por lista.'; end if;
      if order_key is null then
        insert into public.guigs_purchase_orders(shop_id,note,created_by) values(p_shop_id,order_note,actor) returning id into order_key;
        event_action:='created';
      else
        if header.status<>'draft' then raise exception 'Somente rascunhos podem ser editados.'; end if;
        update public.guigs_purchase_orders set note=order_note,version=version+1,updated_at=clock_timestamp() where id=order_key;
        event_action:='items_updated';
      end if;
      select coalesce(jsonb_object_agg(n.product_id::text,n.suggested),'{}') into suggestions from public.guigs_shopping_needs(p_shop_id) n;
      for item in select * from jsonb_to_recordset(p_payload->'items') as
        x(product_id uuid,quantity integer,supplier_id uuid,source text,expected_suggestion integer,note text)
      loop
        if item.quantity is null or item.quantity<=0 or item.source is null or item.source not in ('manual','suggestion')
           or length(coalesce(item.note,''))>1000 then raise exception 'Informe quantidade inteira positiva e observação válida.'; end if;
        select * into old_item from public.guigs_purchase_items
          where shop_id=p_shop_id and order_id=order_key and product_id=item.product_id;
        select * into product from public.guigs_products where shop_id=p_shop_id and id=item.product_id;
        if not found or (not product.active and old_item.id is null) then raise exception 'Produto indisponível nesta loja.'; end if;
        suggestion:=(suggestions->>item.product_id::text)::integer;
        if item.source='suggestion' and (old_item.id is null or old_item.source<>'suggestion') and
           (coalesce(suggestion,0)<=0 or suggestion is distinct from item.expected_suggestion)
        then raise exception 'A sugestão mudou. Atualize a lista ou registre um item manual.'; end if;
        supplier_label:=null;
        if item.supplier_id is not null then
          if old_item.supplier_id is not distinct from item.supplier_id then supplier_label:=old_item.supplier_name;
          else
            select s.name into supplier_label from public.guigs_suppliers s where s.shop_id=p_shop_id and s.id=item.supplier_id and s.active;
            if not found then raise exception 'Fornecedor indisponível nesta loja.'; end if;
          end if;
        end if;
        insert into public.guigs_purchase_items(shop_id,order_id,product_id,product_name,original_suggestion,quantity,source,
          supplier_id,supplier_name,note,created_by)
        values(p_shop_id,order_key,item.product_id,product.name,suggestion,item.quantity,item.source,item.supplier_id,supplier_label,
          btrim(coalesce(item.note,'')),actor)
        on conflict(shop_id,order_id,product_id) do update set quantity=excluded.quantity,source=excluded.source,
          supplier_id=excluded.supplier_id,supplier_name=excluded.supplier_name,note=excluded.note;
      end loop;
      delete from public.guigs_purchase_items i where i.shop_id=p_shop_id and i.order_id=order_key and not exists(
        select 1 from jsonb_to_recordset(p_payload->'items') as x(product_id uuid) where x.product_id=i.product_id);
    else
      if order_key is null or next_status is null or not (
        (header.status='draft' and next_status='pending') or
        (header.status in ('draft','pending','ordered') and next_status='cancelled') or
        (header.status='pending' and next_status='ordered' and member_role='owner') or
        (header.status='ordered' and next_status='received' and member_role='owner'))
      then raise exception 'Transição não permitida.'; end if;
      if next_status='pending' then
        if not exists(select 1 from public.guigs_purchase_items where shop_id=p_shop_id and order_id=order_key) then
          raise exception 'Adicione pelo menos um item antes de preparar o pedido.';
        end if;
        if exists(select 1 from public.guigs_purchase_items i left join public.guigs_shopping_needs(p_shop_id) n on n.product_id=i.product_id
          where i.shop_id=p_shop_id and i.order_id=order_key and i.source='suggestion'
          and coalesce(n.suggested,0)<coalesce(i.original_suggestion,0) and i.quantity>coalesce(n.suggested,0))
        then raise exception 'A necessidade mudou. Revise as quantidades ou confirme os itens como manuais no rascunho.'; end if;
      end if;
      update public.guigs_purchase_orders set status=next_status,version=version+1,updated_at=clock_timestamp() where id=order_key;
      event_action:=next_status;
    end if;
    after_state:=public.guigs_get_purchase_order(p_shop_id,order_key)-'events';
    insert into public.guigs_purchase_events(shop_id,order_id,actor_id,action,previous,current)
      values(p_shop_id,order_key,actor,event_action,before_state,after_state);
    result:=after_state->'order';
  end if;
  insert into guigs_private.purchase_commands(shop_id,request_id,actor_id,payload,result)
    values(p_shop_id,p_request_id,actor,command,result);
  return result;
end $$;

revoke all on function public.guigs_shopping_needs(uuid),public.guigs_get_shopping_board(uuid,integer,integer),
  public.guigs_get_purchase_order(uuid,uuid),public.guigs_apply_shopping_command(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.guigs_shopping_needs(uuid),public.guigs_get_shopping_board(uuid,integer,integer),
  public.guigs_get_purchase_order(uuid,uuid),public.guigs_apply_shopping_command(uuid,uuid,text,jsonb) to authenticated;
commit;
