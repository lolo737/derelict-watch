-- =============================================================================
-- Derelict Watch — Supabase schema
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- It is idempotent: safe to run again after edits.
--
-- Security model (the anon key is public by design, so the database enforces
-- the rules, not the app):
--   * anyone may INSERT a report (only the citizen-facing columns)
--   * anyone may SELECT reports that are not hidden by moderation
--   * nobody using the anon key may UPDATE or DELETE anything
--   * anyone may FLAG a report via flag_report(); enough flags hide it
--     automatically until a moderator reviews it
--   * photos go into a public-read bucket; anon may upload new JPEGs only,
--     named <uuid>.jpg, max 5 MB, and may not overwrite or delete them
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
create table if not exists public.reports (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null unique,               -- generated on the phone; makes offline retries idempotent
  created_at        timestamptz not null default now(),

  street            text not null check (char_length(street) between 1 and 120),
  house_number      text not null check (char_length(house_number) between 1 and 40),
  town              text not null check (char_length(town) between 1 and 80),
  county            text not null check (county in (
                      'Carlow','Cavan','Clare','Cork','Donegal','Dublin','Galway','Kerry',
                      'Kildare','Kilkenny','Laois','Leitrim','Limerick','Longford','Louth',
                      'Mayo','Meath','Monaghan','Offaly','Roscommon','Sligo','Tipperary',
                      'Waterford','Westmeath','Wexford','Wicklow')),
  lat               double precision not null check (lat between 51.2 and 55.6),
  lng               double precision not null check (lng between -10.9 and -5.3),

  empty_band        text not null check (empty_band in
                      ('under_6m','6_12m','1_2y','2_5y','5_10y','over_10y','unknown')),
  upstairs_empty    boolean not null default false,
  downstairs_empty  boolean not null default false,
  notes             text not null default '' check (char_length(notes) <= 500),
  photo_path        text check (photo_path ~ '^[0-9a-f-]{36}\.jpg$'),

  -- Moderation
  moderation_status text not null default 'visible'
                      check (moderation_status in ('visible','hidden','approved')),
  flag_count        integer not null default 0 check (flag_count >= 0),
  moderated_at      timestamptz,

  constraint some_unit_empty check (upstairs_empty or downstairs_empty)
);

create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_county_idx     on public.reports (county);
create index if not exists reports_visible_idx    on public.reports (moderation_status) where moderation_status <> 'hidden';

comment on table  public.reports is 'Citizen reports of vacant/derelict buildings. About buildings, never people.';
comment on column public.reports.moderation_status is 'visible = live; hidden = taken down pending review; approved = reviewed, cannot be auto-hidden by flags.';

-- -----------------------------------------------------------------------------
-- Column-level privileges: anon may only write the citizen-facing columns,
-- so moderation_status / flag_count / id / created_at cannot be forged.
-- -----------------------------------------------------------------------------
revoke all on public.reports from anon, authenticated;

grant select (id, created_at, street, house_number, town, county, lat, lng,
              empty_band, upstairs_empty, downstairs_empty, notes, photo_path)
  on public.reports to anon, authenticated;

grant insert (client_id, street, house_number, town, county, lat, lng,
              empty_band, upstairs_empty, downstairs_empty, notes, photo_path)
  on public.reports to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.reports enable row level security;

drop policy if exists "Anyone can read visible reports" on public.reports;
create policy "Anyone can read visible reports"
  on public.reports for select
  to anon, authenticated
  using (moderation_status <> 'hidden');

drop policy if exists "Anyone can submit a report" on public.reports;
create policy "Anyone can submit a report"
  on public.reports for insert
  to anon, authenticated
  with check (moderation_status = 'visible' and flag_count = 0);

-- No UPDATE or DELETE policies exist for anon/authenticated, and no UPDATE or
-- DELETE privilege is granted, so both are refused. Moderators use the
-- Supabase dashboard (service role), which bypasses RLS.

-- -----------------------------------------------------------------------------
-- Flagging: the one write that touches an existing row, done through a
-- SECURITY DEFINER function that can only increment flag_count.
-- -----------------------------------------------------------------------------
create or replace function public.flag_report(report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hide_threshold constant integer := 3;
begin
  update public.reports
     set flag_count = flag_count + 1,
         moderation_status = case
           when moderation_status = 'visible' and flag_count + 1 >= hide_threshold then 'hidden'
           else moderation_status
         end
   where id = report_id
     and moderation_status <> 'hidden';
end;
$$;

revoke all on function public.flag_report(uuid) from public;
grant execute on function public.flag_report(uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Storage bucket for photos
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', true, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public bucket: files are readable by URL without a SELECT policy, and we
-- deliberately add none, so the bucket cannot be listed/enumerated with the
-- anon key. Uploads only: new objects named <uuid>.jpg. No update/delete.
drop policy if exists "Anyone can upload a report photo" on storage.objects;
create policy "Anyone can upload a report photo"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'report-photos'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
  );
