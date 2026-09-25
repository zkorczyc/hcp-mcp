# HCP Engagement x Neon x MCP (mock pharma demo)

**Model Context Protocol** server for simulated Healthcare Professional (HCP) engagement data — reps, visits/calls/emails, consent status, and prescribing trends — from **Neon**.

All data is synthetic (`example-pharma.com` reps, fictional drug names like `Cardiozin`, sequential NPIs). This is **not** real provider or prescribing data.

Uses the separate Neon project **we.Healthcare** (`young-river-28343758`), not the [Frescopa MCP](https://github.com/zkorczyc/Frescopa-stock) database. Its tables are `hcps`, `hcp_reps`, `hcp_products`, `hcp_interactions`, `hcp_interaction_products`, `hcp_prescribing_trends`, and `hcp_consents`.

| Mode | Use case |
|------|----------|
| **stdio** (`npm start`) | Cursor, Claude Desktop on your Mac |
| **HTTP** (`npm run start:http`) | Adobe AI Assistant, any remote app — public URL |

## Repo layout

| Path | Purpose |
|------|---------|
| `supabase/migrations/20260831000000_hcp_engagement_init.sql` | Tables, synthetic seed data, views (Supabase RLS only when its roles exist) |
| `supabase/migrations/20260831010000_hcp_south_visit_frequency_flat.sql` | Idempotent South/Oncology demo adjustment |
| `src/index.ts` | MCP stdio entry |
| `src/http.ts` | MCP HTTP entry (`POST /mcp`) |
| `src/create-server.ts` | Shared tools |
| `.env.example` | Env template |

## Neon setup

The synthetic dataset is already loaded in the Healthcare project's `production` branch. Do not run these seed migrations again on a populated database without reviewing their effects. For a new empty branch, use a **direct** (unpooled) connection:

```bash
neon link --project-id young-river-28343758 --branch production -y
neon psql production --project-id young-river-28343758 --database-name neondb -- -v ON_ERROR_STOP=1 < supabase/migrations/20260831000000_hcp_engagement_init.sql
neon psql production --project-id young-river-28343758 --database-name neondb -- -v ON_ERROR_STOP=1 < supabase/migrations/20260831010000_hcp_south_visit_frequency_flat.sql
```

Set `DATABASE_URL` to this project's **pooled** connection string for the MCP runtime. Keep connection strings in ignored local env files and Render environment variables, never in Git.

## Local build

```bash
cd /Users/zkorczyc/Projects/hcp-mcp
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
      "args": ["/Users/zkorczyc/Projects/hcp-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "<Healthcare Neon pooled connection string>"
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

Deploy this repo as a Render Node service using `render.yaml`. In Render, set `DATABASE_URL` to the Healthcare project's pooled URL and `MCP_API_KEY` to a separate secret if the MCP client can send `Authorization: Bearer <MCP_API_KEY>`. The HTTP endpoint is `POST /mcp`; `GET /health` checks server availability but does not query the database. This server defaults to **port 3100** locally (vs. Frescopa's 3000).

## Security

- Do not commit `.env`, `.env.local`, or database credentials.
- The Neon database role used by `DATABASE_URL` can write data; use a read-only role for a public read-only MCP deployment.
- Data is synthetic — do not populate with real patient, prescriber, or PHI/PII data.
- **HTTP:** always set `MCP_API_KEY` on public deploy.
