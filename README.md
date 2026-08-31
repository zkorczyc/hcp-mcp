# HCP Engagement × Supabase × MCP (mock pharma demo)

**Model Context Protocol** server for simulated Healthcare Professional (HCP) engagement data — reps, visits/calls/emails, consent status, and prescribing trends — from **Supabase**.

All data is synthetic (`example-pharma.com` reps, fictional drug names like `Cardiozin`, sequential NPIs). This is **not** real provider or prescribing data.

Shares the same Supabase project as the separate [Frescopa MCP](https://github.com/zkorczyc/Frescopa-stock) repo, but lives in its own table namespace (`hcps`, `hcp_reps`, `hcp_products`, `hcp_interactions`, `hcp_interaction_products`, `hcp_prescribing_trends`, `hcp_consents`) — no foreign keys, joins, or code shared between the two.

| Mode | Use case |
|------|----------|
| **stdio** (`npm start`) | Cursor, Claude Desktop on your Mac |
| **HTTP** (`npm run start:http`) | Adobe AI Assistant, any remote app — public URL |

## Repo layout

| Path | Purpose |
|------|---------|
| `../supabase/migrations/20260831000000_hcp_engagement_init.sql` | Tables, RLS (`anon`/`authenticated` read-only), seed data, views |
| `src/index.ts` | MCP stdio entry |
| `src/http.ts` | MCP HTTP entry (`POST /mcp`) |
| `src/create-server.ts` | Shared tools |
| `.env.example` | Env template |

## Supabase setup

1. **SQL**: Dashboard → **SQL Editor** → paste `../supabase/migrations/20260831000000_hcp_engagement_init.sql` → **Run**. Safe to re-run (uses `on conflict do nothing` / `create or replace view`).
2. **API**: reuse the same `SUPABASE_URL` and `SUPABASE_ANON_KEY` from the Frescopa `.env` — same project, read-only anon key.

## Local build

```bash
cd /Users/zkorczyc/Projects/Frescopa/hcp-mcp
cp .env.example .env   # skip if .env already exists
npm install
npm run build
```

## Cursor `mcp.json` snippet

```json
{
  "mcpServers": {
    "hcp-engagement": {
      "command": "node",
      "args": ["/Users/zkorczyc/Projects/Frescopa/hcp-mcp/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://uxlccvzhuwzwzrmqunml.supabase.co",
        "SUPABASE_ANON_KEY": "eyJ..."
      }
    }
  }
}
```

## MCP tools

| Tool | Role |
|------|------|
| `hcp_list_hcps` | List HCPs; filter `specialty`, `tier` (`A`\|`B`\|`C`), `region`, `state` |
| `hcp_search` | Search HCPs by name, NPI, or institution |
| `hcp_get_profile` | Full profile by NPI — demographics, consent status per channel, engagement summary |
| `hcp_list_interactions` | Visits/calls/emails — filter by NPI, region, specialty, rep name, interaction type, days back |
| `hcp_engagement_summary` | **Analytics:** interaction counts, recency, sentiment score, samples per HCP — find engagement gaps |
| `hcp_prescribing_trends` | Monthly new/total Rx and market share % for **one HCP**, optionally scoped to one product |
| `hcp_prescribing_trend_by_segment` | **Analytics:** quarterly Rx trend for one product, broken out by region/specialty (`segment_rollup`) plus per-HCP quarterly rows (`hcp_quarterly`) for drill-down |
| `hcp_visit_frequency_by_segment` | **Analytics:** quarterly interaction/visit frequency by region/specialty — pairs with `hcp_prescribing_trend_by_segment` for side-by-side comparison |
| `hcp_rep_activity` | **Analytics:** per-rep territory summary — HCPs engaged, interaction volume (30d/90d), avg sentiment |

### Example questions this enables

- "Which Tier A cardiologists haven't been visited in 90+ days?" → `hcp_engagement_summary` (filter `tier: A`, `specialty: Cardiology`), then check `last_interaction_at`.
- "Can I drop samples with Dr. Reyes?" → `hcp_get_profile` → check `consents` for `sample_drop`.
- "Summarize my last 3 interactions with Dr. Nguyen." → `hcp_list_interactions` (filter by `npi`).
- "Which reps have the most positive-sentiment interactions?" → `hcp_rep_activity`.

### Demo narrative: "declining Rx despite steady engagement" (coverage-problem hook)

A 4-step chain that ties prescribing trend + rep engagement together to surface a "clinical demand exists, something's blocking it" story — useful for framing a payer/access-coverage narrative rather than a pure sales-execution one:

1. **Baseline, side by side** — "Show me Oncovarin prescribing trends by region and specialty over the last 2 quarters, alongside HCP visit frequency for each region."
   → `hcp_prescribing_trend_by_segment` (`brand_name: Oncovarin`) + `hcp_visit_frequency_by_segment`, both grouped by region/specialty/quarter so they line up.
2. **Isolate the signal** — "Which regions/specialties show declining Oncovarin prescribing despite stable or increasing visit frequency?" → compare the two `segment_rollup` outputs quarter-over-quarter (reasoning step, no new tool needed).
3. **Rule out physician sentiment** — "For HCPs in [flagged region] with declining trends, what's the interaction sentiment from recent visits?" → `hcp_prescribing_trend_by_segment`'s `hcp_quarterly` (filtered to the flagged region) to find the specific decliners, then `hcp_list_interactions` (filter by `npi`, or by `region`+`specialty`) to check sentiment.
4. **Territory context** — "Summarize rep/territory performance in [flagged region] this quarter." → `hcp_rep_activity` (filter `region`).

The seed data has one segment deliberately built to produce this exact pattern: **South region, Oncology, Oncovarin** — prescribing drops sharply in the latest quarter while visit frequency stays comparatively steady and sentiment trends more positive, not less. Everything else in the dataset is pseudo-random (deterministic per NPI, but not hand-tuned), so other region/specialty combinations may or may not show a similar pattern.

## Remote MCP URL (HTTP)

Same pattern as Frescopa — see [`../README.md`](../README.md#remote-mcp-url-http) for the full walkthrough (build → `start:http` → deploy → register URL). This server defaults to **port 3100** (vs. Frescopa's 3000) so both can run locally at once.

## Security

- Do not commit `.env` or **service role** keys.
- Demo is safe with **anon** + RLS limited to `SELECT`.
- Data is synthetic — do not populate with real patient, prescriber, or PHI/PII data.
- **HTTP:** always set `MCP_API_KEY` on public deploy.
