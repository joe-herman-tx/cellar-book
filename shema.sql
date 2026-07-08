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
create policy "select own" on public.tastings
  for select using ( auth.uid() = user_id );

create policy "insert own" on public.tastings
  for insert with check ( auth.uid() = user_id );

create policy "update own" on public.tastings
  for update using ( auth.uid() = user_id );

create policy "delete own" on public.tastings
  for delete using ( auth.uid() = user_id );