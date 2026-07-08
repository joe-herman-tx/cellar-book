-- ============================================================
--  CELLAR BOOK — database schema for Supabase
--  Paste this whole file into: Supabase → SQL Editor → New query → Run
-- ============================================================

-- 1. THE TABLE ------------------------------------------------
--    One row per tasting. `user_id` stamps each row with its owner;
--    it defaults to the logged-in user automatically on insert.
create table if not exists public.tastings (
  id         text primary key,                              -- app-generated id
  user_id    uuid not null default auth.uid()               -- owner = whoever is logged in
                  references auth.users(id) on delete cascade,
  vintage    text,
  name       text not null,
  producer   text,
  region     text,
  grape      text,
  price      text,
  date       date,
  nose       text,
  palate     text,
  body       int,
  tannin     int,
  acidity    int,
  finish     int,
  score      int,
  notes      text,
  created_at timestamptz not null default now()
);

-- 2. ROW-LEVEL SECURITY --------------------------------------
--    With RLS ON, the table denies everything by default.
--    The policies below then re-open access ONLY to your own rows.
--    This is what makes it safe to ship the public "anon" key in a
--    public web app: the key can reach the database, but the database
--    only ever hands back rows where user_id = the logged-in user.
alter table public.tastings enable row level security;

-- 3. POLICIES: you can only see and change rows you own ------
drop policy if exists "select own" on public.tastings;
create policy "select own" on public.tastings
  for select using ( auth.uid() = user_id );

drop policy if exists "insert own" on public.tastings;
create policy "insert own" on public.tastings
  for insert with check ( auth.uid() = user_id );

drop policy if exists "update own" on public.tastings;
create policy "update own" on public.tastings
  for update using ( auth.uid() = user_id );

drop policy if exists "delete own" on public.tastings;
create policy "delete own" on public.tastings
  for delete using ( auth.uid() = user_id );

-- ============================================================
--  4. SHARING — read-only sharing of individual tastings.
--     A tasting is private until you flip `shared` on. Nothing
--     is visible to anyone else unless they're in `partners`
--     AND the row is explicitly marked shared.
-- ============================================================
alter table public.tastings add column if not exists shared boolean not null default false;
alter table public.tastings add column if not exists image_path text;

-- Allowlist: "owner has agreed to share their shared-flagged rows with partner".
-- Insert both directions once your wife has signed up (see bottom of this file).
create table if not exists public.partners (
  owner   uuid not null references auth.users(id) on delete cascade,
  partner uuid not null references auth.users(id) on delete cascade,
  primary key (owner, partner)
);
alter table public.partners enable row level security;

drop policy if exists "select own links" on public.partners;
create policy "select own links" on public.partners
  for select using ( auth.uid() = owner );

-- Additive to "select own" above — Postgres OR's multiple permissive
-- SELECT policies together, so this only ever ADDS visibility.
drop policy if exists "select shared with me" on public.tastings;
create policy "select shared with me" on public.tastings
  for select using (
    shared = true
    and exists (select 1 from public.partners where owner = auth.uid() and partner = tastings.user_id)
  );
-- insert/update/delete stay owner-only (unchanged above) — sharing is read-only.

-- ============================================================
--  5. STORAGE — bucket for label photos.
--     Private bucket; access follows the exact same shared-flag
--     rule as the row itself, not a guessable URL.
--     Object path convention: {user_id}/{tasting_id}
-- ============================================================
insert into storage.buckets (id, name, public)
values ('wine-labels', 'wine-labels', false)
on conflict (id) do nothing;

drop policy if exists "labels: own folder write" on storage.objects;
create policy "labels: own folder write" on storage.objects
  for insert with check (
    bucket_id = 'wine-labels' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "labels: own folder update" on storage.objects;
create policy "labels: own folder update" on storage.objects
  for update using (
    bucket_id = 'wine-labels' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "labels: own folder delete" on storage.objects;
create policy "labels: own folder delete" on storage.objects
  for delete using (
    bucket_id = 'wine-labels' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "labels: select own or shared" on storage.objects;
create policy "labels: select own or shared" on storage.objects
  for select using (
    bucket_id = 'wine-labels' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.tastings t
        join public.partners p on p.owner = auth.uid() and p.partner = t.user_id
        where t.shared = true
          and t.user_id::text = (storage.foldername(name))[1]
          and t.id = split_part(name, '/', 2)
      )
    )
  );

-- ============================================================
--  6. PROFILES — lets a shared card say "Shared by Ana" instead
--     of a raw UUID. Auto-populated on every future sign-up.
-- ============================================================
create table if not exists public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text
);
alter table public.profiles enable row level security;

drop policy if exists "select own or linked profile" on public.profiles;
create policy "select own or linked profile" on public.profiles
  for select using (
    id = auth.uid()
    or id in (select partner from public.partners where owner = auth.uid())
  );

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any account(s) that already existed before this
-- trigger was created (e.g. your own account).
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do update set email = excluded.email;

-- ============================================================
--  ONE-TIME MANUAL STEP — after your wife creates her account via
--  the app's own "Create an account" form, link you two together.
--  Find both UUIDs in Supabase Dashboard → Authentication → Users.
-- ============================================================
-- insert into public.partners (owner, partner) values
--   ('<your-uuid>',  '<wife-uuid>'),
--   ('<wife-uuid>',  '<your-uuid>')
-- on conflict do nothing;

-- ============================================================
--  7. COMMENTS — anyone who can see a tasting (owner, or shared
--     + linked partner) can comment on it. Add/delete only, no
--     editing.
-- ============================================================
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  tasting_id text not null references public.tastings(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);
alter table public.comments enable row level security;

drop policy if exists "select comments on visible tastings" on public.comments;
create policy "select comments on visible tastings" on public.comments
  for select using (
    exists (
      select 1 from public.tastings t
      where t.id = comments.tasting_id
        and (
          t.user_id = auth.uid()
          or (t.shared = true and exists (
            select 1 from public.partners where owner = auth.uid() and partner = t.user_id
          ))
        )
    )
  );

drop policy if exists "insert comments on visible tastings" on public.comments;
create policy "insert comments on visible tastings" on public.comments
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.tastings t
      where t.id = comments.tasting_id
        and (
          t.user_id = auth.uid()
          or (t.shared = true and exists (
            select 1 from public.partners where owner = auth.uid() and partner = t.user_id
          ))
        )
    )
  );

drop policy if exists "delete own comments" on public.comments;
create policy "delete own comments" on public.comments
  for delete using ( user_id = auth.uid() );

-- ============================================================
--  8. CELLAR INVENTORY — bottles you own but haven't tasted yet.
--     Unlike tastings, this is fully shared: both linked partners
--     can see AND edit every row, since it's joint property, not
--     a personal opinion. `added_by` is provenance only.
-- ============================================================
create table if not exists public.cellar (
  id             text primary key,
  vintage        text,
  name           text not null,
  producer       text,
  region         text,
  grape          text,
  price          text,
  quantity       int not null default 1,
  purchased_date date,
  notes          text,
  added_by       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now()
);
alter table public.cellar enable row level security;

drop policy if exists "select own or partner cellar" on public.cellar;
create policy "select own or partner cellar" on public.cellar
  for select using (
    added_by = auth.uid()
    or exists (select 1 from public.partners where owner = auth.uid() and partner = cellar.added_by)
  );

drop policy if exists "insert own cellar" on public.cellar;
create policy "insert own cellar" on public.cellar
  for insert with check ( added_by = auth.uid() );

drop policy if exists "update own or partner cellar" on public.cellar;
create policy "update own or partner cellar" on public.cellar
  for update using (
    added_by = auth.uid()
    or exists (select 1 from public.partners where owner = auth.uid() and partner = cellar.added_by)
  );

drop policy if exists "delete own or partner cellar" on public.cellar;
create policy "delete own or partner cellar" on public.cellar
  for delete using (
    added_by = auth.uid()
    or exists (select 1 from public.partners where owner = auth.uid() and partner = cellar.added_by)
  );

-- ============================================================
--  9. CONNECTIONS — self-service sharing with any number of
--     friends/family, via search-by-email + request/accept.
--     Deliberately a SEPARATE table from `partners`: `partners`
--     means "household" (also grants cellar access); `connections`
--     only ever grants tasting/comment visibility, never cellar.
-- ============================================================
create table if not exists public.connections (
  owner   uuid not null references auth.users(id) on delete cascade,
  partner uuid not null references auth.users(id) on delete cascade,
  primary key (owner, partner)
);
alter table public.connections enable row level security;

drop policy if exists "select own connection links" on public.connections;
create policy "select own connection links" on public.connections
  for select using ( auth.uid() = owner );

create table if not exists public.connection_requests (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references auth.users(id) on delete cascade,
  recipient  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (requester, recipient)
);
alter table public.connection_requests enable row level security;

drop policy if exists "select own requests" on public.connection_requests;
create policy "select own requests" on public.connection_requests
  for select using ( requester = auth.uid() or recipient = auth.uid() );

drop policy if exists "send requests" on public.connection_requests;
create policy "send requests" on public.connection_requests
  for insert with check ( requester = auth.uid() and recipient <> auth.uid() );

drop policy if exists "remove own requests" on public.connection_requests;
create policy "remove own requests" on public.connection_requests
  for delete using ( requester = auth.uid() or recipient = auth.uid() );
-- No update policy — a request is only ever inserted, then either
-- deleted (decline/cancel) or consumed by accept_connection_request().

-- Exact, case-insensitive email lookup only — never partial/fuzzy —
-- so the anon key can't be used to browse or enumerate every user.
create or replace function public.find_user_by_email(lookup_email text)
returns table(id uuid, email text)
language sql
security definer
set search_path = public
as $$
  select id, email from public.profiles where lower(email) = lower(lookup_email) limit 1;
$$;
grant execute on function public.find_user_by_email(text) to authenticated;

-- Atomic accept: verifies the caller is the recipient, links both
-- directions in `connections`, and clears the request — one call
-- instead of several client round-trips that could partially fail.
create or replace function public.accept_connection_request(req_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  select * into req from public.connection_requests where id = req_id;
  if req is null then
    raise exception 'Request not found';
  end if;
  if req.recipient <> auth.uid() then
    raise exception 'Not authorized to accept this request';
  end if;
  insert into public.connections (owner, partner) values
    (req.requester, req.recipient),
    (req.recipient, req.requester)
  on conflict do nothing;
  delete from public.connection_requests where id = req_id;
end;
$$;
grant execute on function public.accept_connection_request(uuid) to authenticated;

-- Unfriend: removes both directions regardless of which side calls
-- it, scoped so you can only ever remove a connection involving you.
create or replace function public.remove_connection(other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.connections
  where (owner = auth.uid() and partner = other)
     or (owner = other and partner = auth.uid());
end;
$$;
grant execute on function public.remove_connection(uuid) to authenticated;

-- ============================================================
--  10. WIDEN VISIBILITY — tastings/comments/storage/profiles now
--      check `partners` (household) OR `connections` (self-service).
--      `cellar` is deliberately NOT touched here — stays partners-only.
-- ============================================================
drop policy if exists "select shared with me" on public.tastings;
create policy "select shared with me" on public.tastings
  for select using (
    shared = true
    and (
      exists (select 1 from public.partners where owner = auth.uid() and partner = tastings.user_id)
      or exists (select 1 from public.connections where owner = auth.uid() and partner = tastings.user_id)
    )
  );

drop policy if exists "select comments on visible tastings" on public.comments;
create policy "select comments on visible tastings" on public.comments
  for select using (
    exists (
      select 1 from public.tastings t
      where t.id = comments.tasting_id
        and (
          t.user_id = auth.uid()
          or (t.shared = true and (
            exists (select 1 from public.partners where owner = auth.uid() and partner = t.user_id)
            or exists (select 1 from public.connections where owner = auth.uid() and partner = t.user_id)
          ))
        )
    )
  );

drop policy if exists "insert comments on visible tastings" on public.comments;
create policy "insert comments on visible tastings" on public.comments
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.tastings t
      where t.id = comments.tasting_id
        and (
          t.user_id = auth.uid()
          or (t.shared = true and (
            exists (select 1 from public.partners where owner = auth.uid() and partner = t.user_id)
            or exists (select 1 from public.connections where owner = auth.uid() and partner = t.user_id)
          ))
        )
    )
  );

drop policy if exists "labels: select own or shared" on storage.objects;
create policy "labels: select own or shared" on storage.objects
  for select using (
    bucket_id = 'wine-labels' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.tastings t
        where t.shared = true
          and t.user_id::text = (storage.foldername(name))[1]
          and t.id = split_part(name, '/', 2)
          and (
            exists (select 1 from public.partners where owner = auth.uid() and partner = t.user_id)
            or exists (select 1 from public.connections where owner = auth.uid() and partner = t.user_id)
          )
      )
    )
  );

drop policy if exists "select own or linked profile" on public.profiles;
create policy "select own or linked profile" on public.profiles
  for select using (
    id = auth.uid()
    or id in (select partner from public.partners where owner = auth.uid())
    or id in (select partner from public.connections where owner = auth.uid())
    or id in (select requester from public.connection_requests where recipient = auth.uid())
    or id in (select recipient from public.connection_requests where requester = auth.uid())
  );

-- ============================================================
--  11. CELLAR SHARING — opt specific connections into VIEW-ONLY
--      cellar access, separate from tasting sharing. Household
--      (`partners`) keeps full edit rights as before; this only
--      ever grants read access, and only to whoever you pick.
--      "Your cellar" here means your whole household's pool (you
--      + anyone in `partners` with you), matching what you see
--      yourself on the Cellar tab — not just your own added rows.
-- ============================================================
alter table public.connections add column if not exists share_cellar boolean not null default false;

-- Toggle via RPC rather than a raw UPDATE policy, so a client can
-- only ever flip the flag on a row it already owns — never touch
-- who a connection actually is.
create or replace function public.set_cellar_sharing(other uuid, share boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.connections set share_cellar = share
  where owner = auth.uid() and partner = other;
$$;
grant execute on function public.set_cellar_sharing(uuid, boolean) to authenticated;

drop policy if exists "select cellar shared with me" on public.cellar;
create policy "select cellar shared with me" on public.cellar
  for select using (
    exists (
      select 1 from public.connections c
      where c.partner = auth.uid() and c.share_cellar = true
        and (
          c.owner = cellar.added_by
          or exists (select 1 from public.partners p where p.owner = c.owner and p.partner = cellar.added_by)
        )
    )
  );

-- ============================================================
--  12. HOUSEHOLD PROMOTION — self-service upgrade of an existing
--      connection to full household member (adds cellar EDIT
--      rights via `partners`, on top of the view-only sharing
--      connections already get). Requires mutual accept, same as
--      forming a connection in the first place, since granting
--      someone edit rights on your cellar is a bigger trust jump
--      than letting them just look. Only ever available between
--      people who are already connections — see the insert check.
-- ============================================================
create table if not exists public.household_requests (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references auth.users(id) on delete cascade,
  recipient  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (requester, recipient)
);
alter table public.household_requests enable row level security;

drop policy if exists "select own household requests" on public.household_requests;
create policy "select own household requests" on public.household_requests
  for select using ( requester = auth.uid() or recipient = auth.uid() );

drop policy if exists "send household requests" on public.household_requests;
create policy "send household requests" on public.household_requests
  for insert with check (
    requester = auth.uid()
    and recipient <> auth.uid()
    and exists (select 1 from public.connections where owner = auth.uid() and partner = recipient)
  );

drop policy if exists "remove own household requests" on public.household_requests;
create policy "remove own household requests" on public.household_requests
  for delete using ( requester = auth.uid() or recipient = auth.uid() );

create or replace function public.accept_household_request(req_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  select * into req from public.household_requests where id = req_id;
  if req is null then
    raise exception 'Request not found';
  end if;
  if req.recipient <> auth.uid() then
    raise exception 'Not authorized to accept this request';
  end if;
  insert into public.partners (owner, partner) values
    (req.requester, req.recipient),
    (req.recipient, req.requester)
  on conflict do nothing;
  delete from public.household_requests where id = req_id;
end;
$$;
grant execute on function public.accept_household_request(uuid) to authenticated;

create or replace function public.remove_household(other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.partners
  where (owner = auth.uid() and partner = other)
     or (owner = other and partner = auth.uid());
end;
$$;
grant execute on function public.remove_household(uuid) to authenticated;

drop policy if exists "select own or linked profile" on public.profiles;
create policy "select own or linked profile" on public.profiles
  for select using (
    id = auth.uid()
    or id in (select partner from public.partners where owner = auth.uid())
    or id in (select partner from public.connections where owner = auth.uid())
    or id in (select requester from public.connection_requests where recipient = auth.uid())
    or id in (select recipient from public.connection_requests where requester = auth.uid())
    or id in (select requester from public.household_requests where recipient = auth.uid())
    or id in (select recipient from public.household_requests where requester = auth.uid())
  );