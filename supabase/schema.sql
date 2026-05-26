-- Simulacra — Supabase schema bootstrap.
-- Run this once in the Supabase SQL editor after creating a new project.
--
-- Note: submitted photos are NEVER stored. They're sent as inline base64 to the
-- Edge Function, forwarded to Claude vision for classification, and discarded
-- after the response. Only the AI's classification (type/brand/model/reason)
-- is persisted. No Storage bucket is needed.

create extension if not exists postgis;

create table if not exists public.user_cameras (
  id             uuid primary key default gen_random_uuid(),
  geom           geometry(Point, 4326) not null,
  bearing        real,
  type           text,
  brand          text,
  model          text,
  ai_confidence  real,
  ai_reason      text,
  status         text not null default 'published'
                   check (status in ('published','review','rejected')),
  reports        int  not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists user_cameras_geom_idx on public.user_cameras using gist (geom);
create index if not exists user_cameras_status_idx on public.user_cameras (status);
create index if not exists user_cameras_created_idx on public.user_cameras (created_at desc);

-- Convenience view: lat/lng pulled out as columns so the anon client doesn't need PostGIS knowledge.
create or replace view public.user_cameras_public as
  select
    id,
    st_x(geom)::float as lng,
    st_y(geom)::float as lat,
    bearing, type, brand, model,
    ai_confidence, ai_reason, reports, created_at
  from public.user_cameras
  where status = 'published';

grant select on public.user_cameras_public to anon;

-- RLS: anon may read published, nothing else. Inserts/updates go through the Edge Function
-- (which uses the service-role key and bypasses RLS).
alter table public.user_cameras enable row level security;

drop policy if exists "anon read published" on public.user_cameras;
create policy "anon read published"
  on public.user_cameras for select
  to anon
  using (status = 'published');

-- Anonymous report bump: callable from the client without auth, only increments `reports`.
create or replace function public.report_camera(camera_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_cameras
     set reports = reports + 1,
         status  = case when reports + 1 >= 3 then 'review' else status end
   where id = camera_id and status = 'published';
end;
$$;

grant execute on function public.report_camera(uuid) to anon;

-- Insert helper. The Edge Function (service role) calls this so the geometry construction
-- lives in SQL instead of being marshalled through PostgREST.
create or replace function public.insert_user_camera(
  _lng float, _lat float,
  _bearing real, _type text, _brand text, _model text,
  _ai_confidence real, _ai_reason text, _status text
) returns table (
  id uuid, lng float, lat float, bearing real, type text,
  brand text, model text,
  ai_confidence real, ai_reason text, status text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare new_id uuid;
begin
  insert into public.user_cameras
    (geom, bearing, type, brand, model, ai_confidence, ai_reason, status)
  values (
    st_setsrid(st_makepoint(_lng, _lat), 4326),
    _bearing, _type, _brand, _model, _ai_confidence, _ai_reason, _status
  )
  returning user_cameras.id into new_id;

  return query
    select c.id, _lng, _lat, c.bearing, c.type, c.brand, c.model,
           c.ai_confidence, c.ai_reason, c.status, c.created_at
      from public.user_cameras c where c.id = new_id;
end;
$$;

-- ---- Migration note ----
-- If you've already deployed an older version of this schema with a `photo_url`
-- column and a `camera-photos` storage bucket, you can drop them safely:
--
--   alter table public.user_cameras drop column if exists photo_url;
--   -- Then delete the camera-photos bucket from the Supabase dashboard.
