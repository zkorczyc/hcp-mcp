-- South/Oncology (Oncovarin) demo segment: keep the Rx collapse (Q2 2026 total_rx_count 486 ->
-- Q3 150) and the sentiment improvement (0.27 -> 0.63) as seeded, but stop visit frequency from
-- dropping alongside Rx. Currently Q3 avg_interactions_per_hcp falls to 4.0 from Q2's 5.5 — this
-- adds enough Q3 visits back to bring it flat at 5.5, so the story reads as "reps visiting just as
-- often, sentiment improving, Rx still falling" rather than "engagement also dropped, but less."
-- Idempotent: guarded by a NOT EXISTS check on hcp_id + notes, safe to re-run.

with extra_visits (npi, days_ago, interaction_type, duration, sentiment, notes) as (
  values
    ('1000000024', 20, 'in_person_visit', 20, 'positive', 'Follow-up on Oncovarin outcomes; reiterated confidence in current regimen.'),
    ('1000000024', 35, 'phone_call', 10, 'neutral', 'Brief check-in call; no new concerns raised.'),
    ('1000000030', 28, 'virtual_visit', 15, 'positive', 'Virtual follow-up; continued positive reception of efficacy data.')
), inserted as (
  insert into public.hcp_interactions (hcp_id, rep_id, interaction_type, occurred_at, duration_minutes, sentiment, samples_left, notes)
  select
    h.id,
    (select r.id from public.hcp_reps r where r.region = h.region order by r.name limit 1),
    ev.interaction_type,
    now() - (ev.days_ago || ' days')::interval,
    ev.duration,
    ev.sentiment,
    false,
    ev.notes
  from extra_visits ev
  join public.hcps h on h.npi = ev.npi
  where not exists (
    select 1 from public.hcp_interactions i2
    where i2.hcp_id = h.id and i2.notes = ev.notes
  )
  returning id
)
insert into public.hcp_interaction_products (interaction_id, product_id, samples_qty, materials_shared, key_message)
select i.id, p.id, 0, true, 'Reviewed Oncovarin outcomes data'
from inserted i, public.hcp_products p
where p.brand_name = 'Oncovarin';
