-- HCP Engagement mock dataset. Use a dedicated Neon project or a Supabase project.
-- Not connected to the Frescopa retail tables.

create extension if not exists "pgcrypto";

-- --- Tables -----------------------------------------------------------------

create table if not exists public.hcp_reps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  territory text not null,
  region text not null check (region in ('northeast', 'midwest', 'south', 'west')),
  hire_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.hcps (
  id uuid primary key default gen_random_uuid(),
  npi text not null unique,
  first_name text not null,
  last_name text not null,
  credentials text not null,
  specialty text not null,
  tier text not null check (tier in ('A', 'B', 'C')),
  institution text not null,
  city text not null,
  state text not null,
  region text not null check (region in ('northeast', 'midwest', 'south', 'west')),
  email text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.hcp_products (
  id uuid primary key default gen_random_uuid(),
  brand_name text not null unique,
  generic_name text not null,
  therapeutic_area text not null,
  ndc_code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.hcp_interactions (
  id uuid primary key default gen_random_uuid(),
  hcp_id uuid not null references public.hcps (id) on delete cascade,
  rep_id uuid not null references public.hcp_reps (id) on delete cascade,
  interaction_type text not null check (
    interaction_type in ('in_person_visit', 'virtual_visit', 'phone_call', 'email', 'conference_booth', 'speaker_program')
  ),
  occurred_at timestamptz not null,
  duration_minutes int not null check (duration_minutes >= 0),
  sentiment text not null check (sentiment in ('positive', 'neutral', 'negative')),
  samples_left boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.hcp_interaction_products (
  interaction_id uuid not null references public.hcp_interactions (id) on delete cascade,
  product_id uuid not null references public.hcp_products (id) on delete cascade,
  samples_qty int not null default 0 check (samples_qty >= 0),
  materials_shared boolean not null default false,
  key_message text,
  primary key (interaction_id, product_id)
);

create table if not exists public.hcp_prescribing_trends (
  id uuid primary key default gen_random_uuid(),
  hcp_id uuid not null references public.hcps (id) on delete cascade,
  product_id uuid not null references public.hcp_products (id) on delete cascade,
  month date not null,
  new_rx_count int not null check (new_rx_count >= 0),
  total_rx_count int not null check (total_rx_count >= 0),
  market_share_pct numeric(5, 2) not null check (market_share_pct between 0 and 100),
  unique (hcp_id, product_id, month)
);

create table if not exists public.hcp_consents (
  id uuid primary key default gen_random_uuid(),
  hcp_id uuid not null references public.hcps (id) on delete cascade,
  consent_type text not null check (
    consent_type in ('email_marketing', 'sample_drop', 'in_person_visit', 'virtual_meeting')
  ),
  status text not null check (status in ('opted_in', 'opted_out', 'pending')),
  updated_at timestamptz not null default now(),
  unique (hcp_id, consent_type)
);

create index if not exists idx_hcps_specialty on public.hcps (specialty);
create index if not exists idx_hcps_region on public.hcps (region);
create index if not exists idx_hcps_tier on public.hcps (tier);
create index if not exists idx_hcp_interactions_hcp on public.hcp_interactions (hcp_id);
create index if not exists idx_hcp_interactions_rep on public.hcp_interactions (rep_id);
create index if not exists idx_hcp_interactions_occurred on public.hcp_interactions (occurred_at);
create index if not exists idx_hcp_prescribing_hcp on public.hcp_prescribing_trends (hcp_id);
create index if not exists idx_hcp_prescribing_product on public.hcp_prescribing_trends (product_id);
create index if not exists idx_hcp_consents_hcp on public.hcp_consents (hcp_id);

-- Supabase API roles get read-only RLS; Neon uses the private server connection.

do $$
declare
  t text;
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach t in array array[
      'hcp_reps', 'hcps', 'hcp_products', 'hcp_interactions',
      'hcp_interaction_products', 'hcp_prescribing_trends', 'hcp_consents'
    ]
    loop
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "hcp_anon_select" on public.%I', t);
      execute format('create policy "hcp_anon_select" on public.%I for select to anon using (true)', t);
      execute format('drop policy if exists "hcp_auth_select" on public.%I', t);
      execute format('create policy "hcp_auth_select" on public.%I for select to authenticated using (true)', t);
    end loop;
  end if;
end $$;

-- --- Seed: reps ---------------------------------------------------------------

insert into public.hcp_reps (name, email, territory, region, hire_date) values
  ('Maria Chen', 'maria.chen@example-pharma.com', 'Northeast I', 'northeast', '2021-03-15'),
  ('James Okafor', 'james.okafor@example-pharma.com', 'Midwest I', 'midwest', '2019-07-01'),
  ('Priya Nair', 'priya.nair@example-pharma.com', 'South I', 'south', '2022-01-10'),
  ('Daniel Silva', 'daniel.silva@example-pharma.com', 'West I', 'west', '2020-09-21'),
  ('Emma Rossi', 'emma.rossi@example-pharma.com', 'Northeast II', 'northeast', '2023-02-06'),
  ('Tom Becker', 'tom.becker@example-pharma.com', 'West II', 'west', '2018-11-12')
on conflict (email) do nothing;

-- --- Seed: drug products -------------------------------------------------------

insert into public.hcp_products (brand_name, generic_name, therapeutic_area, ndc_code) values
  ('Cardiozin', 'ramelostat', 'Cardiology', '00000-1001-01'),
  ('Endovera', 'glucaretin', 'Endocrinology', '00000-1002-01'),
  ('Neurolex', 'neprazidone', 'Neurology', '00000-1003-01'),
  ('Oncovarin', 'trilanumab', 'Oncology', '00000-1004-01'),
  ('Rheumacal', 'artholimide', 'Rheumatology', '00000-1005-01'),
  ('Pulmovex', 'bronchafil', 'Pulmonology', '00000-1006-01')
on conflict (brand_name) do nothing;

-- --- Seed: HCPs (30) ------------------------------------------------------------

insert into public.hcps (npi, first_name, last_name, credentials, specialty, tier, institution, city, state, region, email, phone) values
  ('1000000001', 'Alice', 'Nguyen', 'MD', 'Cardiology', 'A', 'Boston Heart Institute', 'Boston', 'MA', 'northeast', 'a.nguyen@bhi.example.com', '617-555-0101'),
  ('1000000002', 'Robert', 'Klein', 'MD', 'Endocrinology', 'B', 'Metro Endocrine Group', 'New York', 'NY', 'northeast', 'r.klein@metroendo.example.com', '212-555-0102'),
  ('1000000003', 'Sofia', 'Marchetti', 'DO', 'Primary Care', 'C', 'Riverside Family Health', 'Philadelphia', 'PA', 'northeast', 's.marchetti@riverside.example.com', '215-555-0103'),
  ('1000000004', 'David', 'Osei', 'MD', 'Oncology', 'A', 'Northeast Cancer Center', 'New York', 'NY', 'northeast', 'd.osei@necc.example.com', '212-555-0104'),
  ('1000000005', 'Laura', 'Bianchi', 'NP', 'Rheumatology', 'B', 'Harborview Rheumatology', 'Boston', 'MA', 'northeast', 'l.bianchi@harborview.example.com', '617-555-0105'),
  ('1000000006', 'Michael', 'Fitzgerald', 'MD', 'Neurology', 'B', 'Pittsburgh Neuro Associates', 'Pittsburgh', 'PA', 'northeast', 'm.fitzgerald@pna.example.com', '412-555-0106'),
  ('1000000007', 'Grace', 'Lindqvist', 'MD', 'Cardiology', 'C', 'Baystate Cardiac Care', 'Springfield', 'MA', 'northeast', 'g.lindqvist@baystate.example.com', '413-555-0107'),
  ('1000000008', 'Samuel', 'Weiss', 'PA', 'Primary Care', 'C', 'Garden State Family Clinic', 'Newark', 'NJ', 'northeast', 's.weiss@gsfc.example.com', '973-555-0108'),
  ('1000000009', 'Karen', 'Dupont', 'MD', 'Pulmonology', 'B', 'Empire Pulmonary Group', 'New York', 'NY', 'northeast', 'k.dupont@empirepulm.example.com', '212-555-0109'),
  ('1000000010', 'Anthony', 'Russo', 'MD', 'Endocrinology', 'A', 'Liberty Diabetes Center', 'Philadelphia', 'PA', 'northeast', 'a.russo@libertydc.example.com', '215-555-0110'),
  ('1000000011', 'Patricia', 'Whitfield', 'MD', 'Cardiology', 'A', 'Great Lakes Cardiology', 'Chicago', 'IL', 'midwest', 'p.whitfield@glc.example.com', '312-555-0111'),
  ('1000000012', 'Brian', 'Novak', 'DO', 'Primary Care', 'B', 'Midwest Family Practice', 'Milwaukee', 'WI', 'midwest', 'b.novak@mfp.example.com', '414-555-0112'),
  ('1000000013', 'Jennifer', 'Adebayo', 'MD', 'Oncology', 'A', 'Heartland Oncology Institute', 'Detroit', 'MI', 'midwest', 'j.adebayo@hoi.example.com', '313-555-0113'),
  ('1000000014', 'William', 'Kowalski', 'MD', 'Neurology', 'C', 'Twin Cities Neurology', 'Minneapolis', 'MN', 'midwest', 'w.kowalski@tcn.example.com', '612-555-0114'),
  ('1000000015', 'Nicole', 'Hartman', 'NP', 'Rheumatology', 'B', 'Prairie Rheumatology Clinic', 'Des Moines', 'IA', 'midwest', 'n.hartman@prairie.example.com', '515-555-0115'),
  ('1000000016', 'Christopher', 'Boyer', 'MD', 'Endocrinology', 'C', 'St. Louis Endocrine Associates', 'St. Louis', 'MO', 'midwest', 'c.boyer@stlendo.example.com', '314-555-0116'),
  ('1000000017', 'Angela', 'Rutkowski', 'MD', 'Pulmonology', 'B', 'Lakeshore Pulmonary Care', 'Cleveland', 'OH', 'midwest', 'a.rutkowski@lakeshore.example.com', '216-555-0117'),
  ('1000000018', 'Kevin', 'Meyer', 'MD', 'Primary Care', 'C', 'Cornbelt Health Partners', 'Omaha', 'NE', 'midwest', 'k.meyer@cornbelt.example.com', '402-555-0118'),
  ('1000000019', 'Rachel', 'Simmons', 'MD', 'Cardiology', 'B', 'Windy City Heart Center', 'Chicago', 'IL', 'midwest', 'r.simmons@wchc.example.com', '312-555-0119'),
  ('1000000020', 'Marcus', 'Delgado', 'MD', 'Oncology', 'A', 'Gateway Cancer Institute', 'Kansas City', 'MO', 'midwest', 'm.delgado@gci.example.com', '816-555-0120'),
  ('1000000021', 'Stephanie', 'Duncan', 'MD', 'Cardiology', 'A', 'Piedmont Heart Group', 'Atlanta', 'GA', 'south', 's.duncan@piedmont.example.com', '404-555-0121'),
  ('1000000022', 'Gregory', 'Ashford', 'DO', 'Primary Care', 'B', 'Bayou Family Medicine', 'New Orleans', 'LA', 'south', 'g.ashford@bayoufm.example.com', '504-555-0122'),
  ('1000000023', 'Monica', 'Reyes', 'MD', 'Endocrinology', 'B', 'Sunbelt Diabetes Clinic', 'Houston', 'TX', 'south', 'm.reyes@sunbelt.example.com', '713-555-0123'),
  ('1000000024', 'Derek', 'Palmer', 'MD', 'Oncology', 'C', 'Coastal Cancer Center', 'Charleston', 'SC', 'south', 'd.palmer@coastalcc.example.com', '843-555-0124'),
  ('1000000025', 'Vanessa', 'Cole', 'NP', 'Rheumatology', 'B', 'Magnolia Rheumatology', 'Memphis', 'TN', 'south', 'v.cole@magnolia.example.com', '901-555-0125'),
  ('1000000026', 'Andre', 'Fontaine', 'MD', 'Neurology', 'A', 'Capital Neuroscience Group', 'Nashville', 'TN', 'south', 'a.fontaine@capitalneuro.example.com', '615-555-0126'),
  ('1000000027', 'Julia', 'Marsh', 'MD', 'Pulmonology', 'C', 'Lone Star Pulmonary', 'Dallas', 'TX', 'south', 'j.marsh@lonestarpulm.example.com', '214-555-0127'),
  ('1000000028', 'Elena', 'Vasquez', 'MD', 'Primary Care', 'C', 'Sunrise Family Health', 'Miami', 'FL', 'south', 'e.vasquez@sunrisefh.example.com', '305-555-0128'),
  ('1000000029', 'Nathaniel', 'Ford', 'MD', 'Cardiology', 'B', 'Palmetto Cardiac Care', 'Columbia', 'SC', 'south', 'n.ford@palmetto.example.com', '803-555-0129'),
  ('1000000030', 'Hannah', 'Whitmore', 'MD', 'Oncology', 'A', 'Gulf Coast Oncology', 'Tampa', 'FL', 'south', 'h.whitmore@gulfcoast.example.com', '813-555-0130')
on conflict (npi) do nothing;

-- --- Seed: consents (one per HCP × consent type, deterministic status) --------

insert into public.hcp_consents (hcp_id, consent_type, status)
select h.id, ct.consent_type,
  case (abs(hashtext(h.npi || ct.consent_type)) % 10)
    when 0 then 'opted_out'
    when 1 then 'pending'
    else 'opted_in'
  end
from public.hcps h
cross join (
  values ('email_marketing'), ('sample_drop'), ('in_person_visit'), ('virtual_meeting')
) as ct(consent_type)
on conflict (hcp_id, consent_type) do nothing;

-- --- Seed: interactions (deterministic pseudo-random, ~8 per HCP over 6 months) --

insert into public.hcp_interactions (hcp_id, rep_id, interaction_type, occurred_at, duration_minutes, sentiment, samples_left, notes)
select
  h.id,
  r.id,
  itype.interaction_type,
  now() - (make_interval(days => (abs(hashtext(h.npi || n::text || 'day')) % 180))),
  case itype.interaction_type
    when 'in_person_visit' then 15 + (abs(hashtext(h.npi || n::text || 'dur')) % 20)
    when 'virtual_visit' then 10 + (abs(hashtext(h.npi || n::text || 'dur')) % 15)
    when 'conference_booth' then 5 + (abs(hashtext(h.npi || n::text || 'dur')) % 10)
    when 'speaker_program' then 45 + (abs(hashtext(h.npi || n::text || 'dur')) % 30)
    else 3 + (abs(hashtext(h.npi || n::text || 'dur')) % 12)
  end,
  case (abs(hashtext(h.npi || n::text || 'sent')) % 10)
    when 0 then 'negative'
    when 1 then 'negative'
    when 2 then 'neutral'
    when 3 then 'neutral'
    else 'positive'
  end,
  (abs(hashtext(h.npi || n::text || 'sample')) % 3) = 0,
  'Discussed efficacy data and patient fit; follow-up scheduled.'
from public.hcps h
cross join generate_series(1, 8) as n
join public.hcp_reps r
  on r.region = h.region
  and r.id = (
    select id from public.hcp_reps r2
    where r2.region = h.region
    order by (abs(hashtext(h.npi || n::text || r2.id::text)))
    limit 1
  )
cross join lateral (
  select (array['in_person_visit', 'virtual_visit', 'phone_call', 'email', 'conference_booth', 'speaker_program'])
    [1 + (abs(hashtext(h.npi || n::text || 'type')) % 6)] as interaction_type
) as itype;

-- --- Seed: interaction_products (1–2 products per interaction) ----------------

insert into public.hcp_interaction_products (interaction_id, product_id, samples_qty, materials_shared, key_message)
select
  i.id,
  p.id,
  case when i.samples_left then 2 + (abs(hashtext(i.id::text || 'qty')) % 8) else 0 end,
  (abs(hashtext(i.id::text || p.id::text || 'mat')) % 2) = 0,
  'Reviewed dosing and safety profile for ' || p.brand_name
from public.hcp_interactions i
join public.hcps h on h.id = i.hcp_id
join public.hcp_products p
  on p.id = (
    select id from public.hcp_products p2
    order by (abs(hashtext(i.id::text || p2.id::text)))
    limit 1
  );

-- Second product on ~40% of interactions
insert into public.hcp_interaction_products (interaction_id, product_id, samples_qty, materials_shared, key_message)
select
  i.id,
  p.id,
  0,
  (abs(hashtext(i.id::text || p.id::text || 'mat2')) % 2) = 0,
  'Also touched on ' || p.brand_name || ' as an alternative option'
from public.hcp_interactions i
join public.hcp_products p
  on p.id = (
    select id from public.hcp_products p2
    order by (abs(hashtext(i.id::text || p2.id::text || 'second')))
    limit 1
  )
where (abs(hashtext(i.id::text || 'second_flag')) % 10) < 4
on conflict (interaction_id, product_id) do nothing;

-- --- Seed: prescribing trends (6 months × every HCP/product pair relevant to specialty) --

insert into public.hcp_prescribing_trends (hcp_id, product_id, month, new_rx_count, total_rx_count, market_share_pct)
select
  h.id,
  p.id,
  date_trunc('month', now() - make_interval(months => m))::date,
  base_new + (m * trend_step) + (abs(hashtext(h.npi || p.brand_name || m::text || 'new')) % 5),
  base_total + (m * trend_step * 3) + (abs(hashtext(h.npi || p.brand_name || m::text || 'total')) % 15),
  round((10 + (abs(hashtext(h.npi || p.brand_name || m::text || 'share')) % 40))::numeric, 1)
from public.hcps h
join public.hcp_products p on p.therapeutic_area = h.specialty
cross join generate_series(0, 5) as m
cross join lateral (
  select
    5 + (abs(hashtext(h.npi || p.brand_name)) % 10) as base_new,
    20 + (abs(hashtext(h.npi || p.brand_name || 'tot')) % 40) as base_total,
    (case when (abs(hashtext(h.npi || p.brand_name || 'trend')) % 2) = 0 then 1 else -1 end) as trend_step
) as seed
on conflict (hcp_id, product_id, month) do nothing;

-- --- Narrative seed: South/Oncology Oncovarin — prescribing decline despite steady/positive
-- rep engagement (the "coverage problem, not a physician-interest problem" demo scenario).
-- Randomized seed above is enough for exploratory queries; this override guarantees the
-- specific pattern is present and discoverable for the flagged segment.

update public.hcp_prescribing_trends t
set new_rx_count = v.new_rx,
    total_rx_count = v.total_rx,
    market_share_pct = v.share
from (
  values
    (0, 8, 30, 18.0),
    (1, 14, 45, 24.0),
    (2, 20, 60, 29.0),
    (3, 34, 95, 35.0),
    (4, 30, 88, 33.0),
    (5, 26, 80, 31.0)
) as v(months_ago, new_rx, total_rx, share),
public.hcps h,
public.hcp_products p
where h.npi in ('1000000024', '1000000030')
  and p.brand_name = 'Oncovarin'
  and t.hcp_id = h.id
  and t.product_id = p.id
  and t.month = date_trunc('month', now() - (v.months_ago || ' months')::interval)::date;

with extra_visits (npi, days_ago, interaction_type, duration, samples_left, notes) as (
  values
    ('1000000024', 12, 'in_person_visit', 25, true, 'Reaffirmed strong interest in Oncovarin for advanced-stage patients.'),
    ('1000000024', 50, 'virtual_visit', 15, false, 'Discussed recent efficacy data; positive reception.'),
    ('1000000030', 8, 'in_person_visit', 30, true, 'Requested additional samples; enthusiastic about outcomes data.'),
    ('1000000030', 55, 'speaker_program', 60, false, 'Attended regional speaker program; asked detailed follow-up questions.')
), inserted as (
  insert into public.hcp_interactions (hcp_id, rep_id, interaction_type, occurred_at, duration_minutes, sentiment, samples_left, notes)
  select
    h.id,
    (select r.id from public.hcp_reps r where r.region = h.region order by r.name limit 1),
    ev.interaction_type,
    now() - (ev.days_ago || ' days')::interval,
    ev.duration,
    'positive',
    ev.samples_left,
    ev.notes
  from extra_visits ev
  join public.hcps h on h.npi = ev.npi
  returning id, hcp_id, samples_left
)
insert into public.hcp_interaction_products (interaction_id, product_id, samples_qty, materials_shared, key_message)
select i.id, p.id, case when i.samples_left then 6 else 0 end, true, 'Reviewed Oncovarin outcomes data'
from inserted i, public.hcp_products p
where p.brand_name = 'Oncovarin';

-- --- Views ----------------------------------------------------------------------

create or replace view public.v_hcp_engagement_summary as
with samples as (
  select interaction_id, sum(samples_qty) as samples_qty
  from public.hcp_interaction_products
  group by interaction_id
)
select
  h.id as hcp_id,
  h.npi,
  h.first_name,
  h.last_name,
  h.specialty,
  h.tier,
  h.region,
  count(i.id) as total_interactions,
  count(i.id) filter (where i.occurred_at >= now() - interval '90 days') as interactions_last_90_days,
  max(i.occurred_at) as last_interaction_at,
  (array_agg(i.interaction_type order by i.occurred_at desc))[1] as last_interaction_type,
  coalesce(sum(case when i.sentiment = 'positive' then 1 when i.sentiment = 'negative' then -1 else 0 end), 0) as sentiment_score,
  coalesce(sum(s.samples_qty), 0) as total_samples_dropped
from public.hcps h
left join public.hcp_interactions i on i.hcp_id = h.id
left join samples s on s.interaction_id = i.id
group by h.id, h.npi, h.first_name, h.last_name, h.specialty, h.tier, h.region;

create or replace view public.v_rep_territory_summary as
select
  r.id as rep_id,
  r.name as rep_name,
  r.territory,
  r.region,
  count(distinct i.hcp_id) as hcps_engaged,
  count(i.id) as total_interactions,
  count(i.id) filter (where i.occurred_at >= now() - interval '30 days') as interactions_last_30_days,
  count(i.id) filter (where i.occurred_at >= now() - interval '90 days') as interactions_last_90_days,
  coalesce(round(avg(case when i.sentiment = 'positive' then 1 when i.sentiment = 'negative' then -1 else 0 end)::numeric, 2), 0) as avg_sentiment_score
from public.hcp_reps r
left join public.hcp_interactions i on i.rep_id = r.id
group by r.id, r.name, r.territory, r.region;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on public.v_hcp_engagement_summary to anon, authenticated;
    grant select on public.v_rep_territory_summary to anon, authenticated;
  end if;
end $$;
