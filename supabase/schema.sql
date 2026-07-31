-- FERMEL — Supabase / PostgreSQL
-- À exécuter dans Supabase > SQL Editor.
-- IMPORTANT : les mots de passe sont gérés uniquement par Supabase Auth.
-- Le crédit de parrainage de 200 FCFA est un crédit BOOST interne,
-- non retirable, non transférable et non convertible en solde bancaire.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  referral_code text not null unique,
  referred_by uuid references public.profiles(id),
  boost_credits integer not null default 0 check (boost_credits >= 0),
  boosts_used integer not null default 0 check (boosts_used >= 0),
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  referred_id uuid not null unique references public.profiles(id) on delete cascade,
  reward_amount integer not null default 200 check (reward_amount = 200),
  reward_type text not null default 'boost' check (reward_type = 'boost'),
  status text not null default 'credited' check (status in ('credited','revoked')),
  created_at timestamptz not null default now(),
  unique(referrer_id, referred_id)
);

create table if not exists public.boost_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount <> 0),
  entry_type text not null check (entry_type in ('referral_credit','boost_use','admin_adjustment')),
  referral_id uuid references public.referrals(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  unique(referral_id)
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  amount_xof integer not null,
  method text,
  status text not null default 'ok',
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  price_xof integer not null check (price_xof >= 0),
  product_type text not null check (product_type in ('digital','physical')),
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  total_xof integer not null check (total_xof >= 0),
  status text not null default 'pending'
    check (status in ('pending','paid','processing','shipped','completed','cancelled','refunded')),
  payment_provider text,
  payment_reference text unique,
  payment_transaction_id bigint,
  payment_url text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price_xof integer not null check (unit_price_xof >= 0)
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  order_id uuid references public.orders(id) on delete set null,
  status text not null,
  payload jsonb,
  created_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);

create or replace function public.generate_referral_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c text;
begin
  loop
    c := 'FRM-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
    exit when not exists (select 1 from public.profiles where referral_code = c);
  end loop;
  return c;
end;
$$;

create or replace function public.create_profile_for_user(
  p_user_id uuid,
  p_full_name text,
  p_phone text default null,
  p_referral_code text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_referrer uuid;
  v_referral public.referrals;
begin
  if p_user_id is null then
    raise exception 'invalid_user';
  end if;

  if exists (select 1 from public.profiles where id = p_user_id) then
    select * into v_profile from public.profiles where id = p_user_id;
    return v_profile;
  end if;

  if p_referral_code is not null and trim(p_referral_code) <> '' then
    select id into v_referrer
    from public.profiles
    where referral_code = upper(trim(p_referral_code))
    limit 1;
  end if;

  insert into public.profiles(id, full_name, phone, referral_code, referred_by)
  values (
    p_user_id,
    trim(p_full_name),
    nullif(trim(p_phone), ''),
    public.generate_referral_code(),
    v_referrer
  )
  returning * into v_profile;

  if v_referrer is not null and v_referrer <> p_user_id then
    insert into public.referrals(referrer_id, referred_id)
    values (v_referrer, p_user_id)
    on conflict (referred_id) do nothing
    returning * into v_referral;

    if v_referral.id is not null then
      update public.profiles
      set boost_credits = boost_credits + 200
      where id = v_referrer;

      insert into public.boost_ledger(
        user_id, amount, entry_type, referral_id, note
      )
      values (
        v_referrer, 200, 'referral_credit', v_referral.id,
        'Parrainage validé — crédit boost de 200 FCFA'
      )
      on conflict (referral_id) do nothing;
    end if;
  end if;

  return v_profile;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.create_profile_for_user(
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'Utilisateur FERMEL'),
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'referral_code'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

create or replace function public.create_profile(
  p_full_name text,
  p_phone text default null,
  p_referral_code text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  return public.create_profile_for_user(
    auth.uid(), p_full_name, p_phone, p_referral_code
  );
end;
$$;

create or replace function public.use_boost()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  update public.profiles
  set boost_credits = boost_credits - 200,
      boosts_used = boosts_used + 1
  where id = auth.uid()
    and boost_credits >= 200
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'insufficient_boost_credit';
  end if;

  insert into public.boost_ledger(user_id, amount, entry_type, note)
  values (auth.uid(), -200, 'boost_use', 'Utilisation d’un crédit boost');

  return v_profile;
end;
$$;
