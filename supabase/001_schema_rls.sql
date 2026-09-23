-- GUIG'S STOCK 1.2B — executar no SQL Editor de um projeto Supabase de TESTES.
-- Padrão seguro: sem acesso anon; nenhum INSERT/UPDATE/DELETE de estoque pelo navegador nesta etapa.
-- Nunca colocar secret key / service_role no frontend.
begin;
create extension if not exists pgcrypto;

create table if not exists public.guigs_shops (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(trim(name)) between 1 and 120),
 created_at timestamptz not null default now()
);
create table if not exists public.guigs_memberships (
 shop_id uuid not null references public.guigs_shops(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check (role in ('owner','attendant')),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 primary key (shop_id,user_id)
);
create table if not exists public.guigs_products (
 id uuid primary key default gen_random_uuid(),
 shop_id uuid not null references public.guigs_shops(id),
 name text not null check (length(trim(name)) between 1 and 160),
 category text not null default 'Outro',
 min_total integer not null default 0 check (min_total >= 0),
 target_total integer not null default 0 check (target_total >= min_total),
 min_fridge integer not null default 0 check (min_fridge >= 0),
 target_fridge integer not null default 0 check (target_fridge >= min_fridge),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 unique(shop_id,id)
);
create table if not exists public.guigs_lots (
 id uuid primary key default gen_random_uuid(),
 shop_id uuid not null references public.guigs_shops(id),
 product_id uuid not null,
 code text not null check (length(trim(code)) between 1 and 120),
 expiry date not null,
 created_at timestamptz not null default now(),
 unique(shop_id,id),
 unique(shop_id,product_id,code,expiry),
 foreign key (shop_id,product_id) references public.guigs_products(shop_id,id)
);
create table if not exists public.guigs_movements (
 id uuid primary key default gen_random_uuid(),
 shop_id uuid not null references public.guigs_shops(id),
 lot_id uuid not null,
 event_id uuid not null, -- duas linhas compartilham evento para transferências
 movement_type text not null check (movement_type in ('receipt','transfer','return','sale','loss','adjust')),
 location text not null check (location in ('stock','fridge')),
 delta integer not null check (delta <> 0),
 actor_id uuid not null references auth.users(id),
 note text not null default '' check (length(note) <= 1000),
 created_at timestamptz not null default now(),
 foreign key (shop_id,lot_id) references public.guigs_lots(shop_id,id)
);
create index if not exists guigs_memberships_user_idx on public.guigs_memberships(user_id);
create index if not exists guigs_lots_product_idx on public.guigs_lots(shop_id,product_id);
create index if not exists guigs_movements_lot_idx on public.guigs_movements(shop_id,lot_id,created_at);

-- Helpers não expostos como endpoints REST (schema privado), usados apenas pelas políticas.
create schema if not exists guigs_private;
create or replace function guigs_private.is_member(p_shop uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.guigs_memberships m
 where m.shop_id = p_shop and m.user_id = (select auth.uid()) and m.active);
$$;
revoke all on function guigs_private.is_member(uuid) from public;
grant usage on schema guigs_private to authenticated;
grant execute on function guigs_private.is_member(uuid) to authenticated;

alter table public.guigs_shops enable row level security;
alter table public.guigs_memberships enable row level security;
alter table public.guigs_products enable row level security;
alter table public.guigs_lots enable row level security;
alter table public.guigs_movements enable row level security;
revoke all on public.guigs_shops,public.guigs_memberships,public.guigs_products,public.guigs_lots,public.guigs_movements from anon,authenticated;
grant select on public.guigs_shops,public.guigs_memberships,public.guigs_products,public.guigs_lots,public.guigs_movements to authenticated;

-- Criar políticas idempotentes, compatíveis com reexecução da migração.
drop policy if exists guigs_shops_read on public.guigs_shops;
create policy guigs_shops_read on public.guigs_shops for select to authenticated
 using (guigs_private.is_member(id));
drop policy if exists guigs_memberships_self_read on public.guigs_memberships;
create policy guigs_memberships_self_read on public.guigs_memberships for select to authenticated
 using (user_id = (select auth.uid()) and active);
drop policy if exists guigs_products_read on public.guigs_products;
create policy guigs_products_read on public.guigs_products for select to authenticated
 using (guigs_private.is_member(shop_id));
drop policy if exists guigs_lots_read on public.guigs_lots;
create policy guigs_lots_read on public.guigs_lots for select to authenticated
 using (guigs_private.is_member(shop_id));
drop policy if exists guigs_movements_read on public.guigs_movements;
create policy guigs_movements_read on public.guigs_movements for select to authenticated
 using (guigs_private.is_member(shop_id));
commit;
