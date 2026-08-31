import type { SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonText } from "./lib/json.js";

const REGION = z.enum(["northeast", "midwest", "south", "west"]);
const TIER = z.enum(["A", "B", "C"]);
const INTERACTION_TYPE = z.enum([
  "in_person_visit",
  "virtual_visit",
  "phone_call",
  "email",
  "conference_booth",
  "speaker_program",
]);

/** e.g. "2026-Q2" from a YYYY-MM-DD or ISO date string, using UTC to match stored `date`/`timestamptz` values. */
function quarterKey(dateStr: string): string {
  const d = new Date(dateStr);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

function sentimentScore(sentiment: string): number {
  return sentiment === "positive" ? 1 : sentiment === "negative" ? -1 : 0;
}

/** Shared MCP tool registrations for stdio and HTTP transports. */
export function createHcpServer(supabase: SupabaseClient): McpServer {
  const server = new McpServer({
    name: "hcp-engagement",
    version: "1.0.0",
  });

  server.tool(
    "hcp_list_hcps",
    "List Healthcare Professionals (HCPs). Filter by specialty, tier (A|B|C), region, or state. Mock data — not real providers.",
    {
      specialty: z.string().optional().describe("e.g. Cardiology, Oncology, Primary Care"),
      tier: TIER.optional(),
      region: REGION.optional(),
      state: z.string().optional().describe("Two-letter state code, e.g. NY"),
      limit: z.number().int().min(1).max(100).optional().default(50),
    },
    async ({ specialty, tier, region, state, limit }) => {
      let q = supabase
        .from("hcps")
        .select("id, npi, first_name, last_name, credentials, specialty, tier, institution, city, state, region")
        .eq("is_active", true)
        .order("tier")
        .order("last_name")
        .limit(limit ?? 50);
      if (specialty?.trim()) q = q.ilike("specialty", specialty.trim());
      if (tier) q = q.eq("tier", tier);
      if (region) q = q.eq("region", region);
      if (state?.trim()) q = q.ilike("state", state.trim());
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return jsonText({ hcp_count: data?.length ?? 0, hcps: data ?? [] });
    }
  );

  server.tool(
    "hcp_search",
    "Search HCPs by name, NPI, or institution (partial match).",
    {
      query: z.string().min(1).describe("e.g. Nguyen, 1000000001, Boston Heart Institute"),
    },
    async ({ query: qstr }) => {
      const term = `%${qstr.trim()}%`;
      const base = () =>
        supabase
          .from("hcps")
          .select("id, npi, first_name, last_name, credentials, specialty, tier, institution, city, state, region")
          .eq("is_active", true);
      const [{ data: byNpi, error: e1 }, { data: byLast, error: e2 }, { data: byFirst, error: e3 }, { data: byInst, error: e4 }] =
        await Promise.all([
          base().ilike("npi", term),
          base().ilike("last_name", term),
          base().ilike("first_name", term),
          base().ilike("institution", term),
        ]);
      if (e1) throw new Error(e1.message);
      if (e2) throw new Error(e2.message);
      if (e3) throw new Error(e3.message);
      if (e4) throw new Error(e4.message);
      type H = NonNullable<typeof byNpi>[number];
      const map = new Map<string, H>();
      for (const row of [...(byNpi ?? []), ...(byLast ?? []), ...(byFirst ?? []), ...(byInst ?? [])]) {
        map.set(row.id, row);
      }
      const hcps = [...map.values()];
      if (!hcps.length) return jsonText({ matches: [], note: "No HCPs match the query." });
      return jsonText({ matches: hcps.length, hcps });
    }
  );

  server.tool(
    "hcp_get_profile",
    "Full profile for one HCP by NPI: demographics, consent status per channel, and engagement summary.",
    {
      npi: z.string().min(1).describe("10-digit NPI, e.g. 1000000001"),
    },
    async ({ npi }) => {
      const { data: hcp, error: he } = await supabase.from("hcps").select("*").eq("npi", npi.trim()).maybeSingle();
      if (he) throw new Error(he.message);
      if (!hcp) return jsonText({ note: `No HCP found with NPI ${npi}.` });

      const [{ data: consents, error: ce }, { data: summary, error: se }] = await Promise.all([
        supabase.from("hcp_consents").select("consent_type, status, updated_at").eq("hcp_id", hcp.id),
        supabase.from("v_hcp_engagement_summary").select("*").eq("hcp_id", hcp.id).maybeSingle(),
      ]);
      if (ce) throw new Error(ce.message);
      if (se) throw new Error(se.message);

      return jsonText({ hcp, consents: consents ?? [], engagement_summary: summary ?? null });
    }
  );

  server.tool(
    "hcp_list_interactions",
    "List rep-HCP interactions (visits, calls, emails). Filter by HCP NPI, region, specialty, rep name, interaction type, or how many days back.",
    {
      npi: z.string().optional().describe("Filter to one HCP by NPI"),
      region: REGION.optional(),
      specialty: z.string().optional().describe("e.g. Cardiology, Oncology"),
      rep_name: z.string().optional().describe("Partial match on rep name"),
      interaction_type: INTERACTION_TYPE.optional(),
      since_days: z.number().int().min(1).max(365).optional().default(90),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ npi, region, specialty, rep_name, interaction_type, since_days, limit }) => {
      let hcpIds: string[] | undefined;
      if (npi?.trim() || region || specialty?.trim()) {
        let hq = supabase.from("hcps").select("id");
        if (npi?.trim()) hq = hq.eq("npi", npi.trim());
        if (region) hq = hq.eq("region", region);
        if (specialty?.trim()) hq = hq.ilike("specialty", specialty.trim());
        const { data: hcps, error: he } = await hq;
        if (he) throw new Error(he.message);
        if (!hcps?.length) return jsonText({ interactions: [], note: "No HCPs match the given npi/region/specialty filter." });
        hcpIds = hcps.map((h) => h.id);
      }

      let repId: string | undefined;
      if (rep_name?.trim()) {
        const { data: reps, error: re } = await supabase
          .from("hcp_reps")
          .select("id")
          .ilike("name", `%${rep_name.trim()}%`);
        if (re) throw new Error(re.message);
        if (!reps?.length) return jsonText({ interactions: [], note: `No rep matches "${rep_name}".` });
        repId = reps[0].id;
      }

      const sinceDate = new Date(Date.now() - (since_days ?? 90) * 86400000).toISOString();
      let q = supabase
        .from("hcp_interactions")
        .select(
          "id, occurred_at, interaction_type, duration_minutes, sentiment, samples_left, notes, hcp:hcps(npi,first_name,last_name,specialty,region), rep:hcp_reps(name,territory), products:hcp_interaction_products(samples_qty,materials_shared,key_message,product:hcp_products(brand_name))"
        )
        .gte("occurred_at", sinceDate)
        .order("occurred_at", { ascending: false })
        .limit(limit ?? 50);
      if (hcpIds) q = q.in("hcp_id", hcpIds);
      if (repId) q = q.eq("rep_id", repId);
      if (interaction_type) q = q.eq("interaction_type", interaction_type);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return jsonText({ interaction_count: data?.length ?? 0, interactions: data ?? [] });
    }
  );

  server.tool(
    "hcp_engagement_summary",
    "Analytics: total interactions, recency, sentiment score, and samples per HCP. Sorted by most interactions first. Useful for finding engagement gaps (e.g. Tier A HCPs with no recent contact).",
    {
      tier: TIER.optional(),
      specialty: z.string().optional(),
      region: REGION.optional(),
      limit: z.number().int().min(1).max(100).optional().default(30),
    },
    async ({ tier, specialty, region, limit }) => {
      let q = supabase
        .from("v_hcp_engagement_summary")
        .select("*")
        .order("total_interactions", { ascending: false })
        .limit(limit ?? 30);
      if (tier) q = q.eq("tier", tier);
      if (specialty?.trim()) q = q.ilike("specialty", specialty.trim());
      if (region) q = q.eq("region", region);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return jsonText({ hcp_count: data?.length ?? 0, engagement: data ?? [] });
    }
  );

  server.tool(
    "hcp_prescribing_trends",
    "Monthly prescribing trend (new Rx, total Rx, market share %) for an HCP, optionally scoped to one product. Requires npi.",
    {
      npi: z.string().min(1).describe("10-digit NPI, e.g. 1000000001"),
      brand_name: z.string().optional().describe("e.g. Cardiozin — omit for all products this HCP prescribes"),
      months_back: z.number().int().min(1).max(24).optional().default(6),
    },
    async ({ npi, brand_name, months_back }) => {
      const { data: hcp, error: he } = await supabase.from("hcps").select("id").eq("npi", npi.trim()).maybeSingle();
      if (he) throw new Error(he.message);
      if (!hcp) return jsonText({ trends: [], note: `No HCP found with NPI ${npi}.` });

      const sinceMonth = new Date();
      sinceMonth.setMonth(sinceMonth.getMonth() - (months_back ?? 6));
      let q = supabase
        .from("hcp_prescribing_trends")
        .select("month, new_rx_count, total_rx_count, market_share_pct, product:hcp_products(brand_name,generic_name,therapeutic_area)")
        .eq("hcp_id", hcp.id)
        .gte("month", sinceMonth.toISOString().slice(0, 10))
        .order("month", { ascending: true });
      const { data, error } = await q;
      if (error) throw new Error(error.message);

      const filtered = brand_name?.trim()
        ? (data ?? []).filter((row) => {
            const product = row.product as { brand_name?: string } | null;
            return product?.brand_name?.toLowerCase() === brand_name.trim().toLowerCase();
          })
        : (data ?? []);

      return jsonText({ npi, trend_rows: filtered.length, trends: filtered });
    }
  );

  server.tool(
    "hcp_prescribing_trend_by_segment",
    "Quarterly prescribing trend for one product, broken out by region and specialty (segment_rollup), plus per-HCP quarterly rows (hcp_quarterly) for drill-down into which specific HCPs are declining/growing. Use segment_rollup to compare regions/specialties side by side; use hcp_quarterly to find individual decliners within a flagged segment.",
    {
      brand_name: z.string().min(1).describe("e.g. Oncovarin"),
      region: REGION.optional(),
      specialty: z.string().optional().describe("e.g. Oncology"),
      quarters_back: z.number().int().min(1).max(8).optional().default(2),
    },
    async ({ brand_name, region, specialty, quarters_back }) => {
      const { data: product, error: pe } = await supabase
        .from("hcp_products")
        .select("id, brand_name")
        .ilike("brand_name", `%${brand_name.trim()}%`)
        .maybeSingle();
      if (pe) throw new Error(pe.message);
      if (!product) return jsonText({ note: `No product matches "${brand_name}".` });

      let hq = supabase.from("hcps").select("id, npi, first_name, last_name, region, specialty, tier");
      if (region) hq = hq.eq("region", region);
      if (specialty?.trim()) hq = hq.ilike("specialty", specialty.trim());
      const { data: hcps, error: he } = await hq;
      if (he) throw new Error(he.message);
      if (!hcps?.length) return jsonText({ note: "No HCPs match the given region/specialty filter." });
      const hcpMap = new Map(hcps.map((h) => [h.id, h]));

      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - (quarters_back ?? 2) * 3);
      const { data: rows, error: te } = await supabase
        .from("hcp_prescribing_trends")
        .select("hcp_id, month, new_rx_count, total_rx_count, market_share_pct")
        .eq("product_id", product.id)
        .in(
          "hcp_id",
          hcps.map((h) => h.id)
        )
        .gte("month", cutoff.toISOString().slice(0, 10))
        .order("month", { ascending: true });
      if (te) throw new Error(te.message);
      if (!rows?.length) return jsonText({ product: product.brand_name, segment_rollup: [], hcp_quarterly: [] });

      type HcpQuarter = {
        npi: string;
        name: string;
        region: string;
        specialty: string;
        tier: string;
        quarter: string;
        new_rx_count: number;
        total_rx_count: number;
        market_share_sum: number;
        month_count: number;
      };
      const byHcpQuarter = new Map<string, HcpQuarter>();
      for (const row of rows) {
        const hcp = hcpMap.get(row.hcp_id);
        if (!hcp) continue;
        const quarter = quarterKey(row.month);
        const key = `${hcp.id}|${quarter}`;
        const acc = byHcpQuarter.get(key) ?? {
          npi: hcp.npi,
          name: `${hcp.first_name} ${hcp.last_name}`,
          region: hcp.region,
          specialty: hcp.specialty,
          tier: hcp.tier,
          quarter,
          new_rx_count: 0,
          total_rx_count: 0,
          market_share_sum: 0,
          month_count: 0,
        };
        acc.new_rx_count += row.new_rx_count;
        acc.total_rx_count += row.total_rx_count;
        acc.market_share_sum += Number(row.market_share_pct);
        acc.month_count += 1;
        byHcpQuarter.set(key, acc);
      }
      const hcpQuarterly = [...byHcpQuarter.values()]
        .map(({ market_share_sum, month_count, ...rest }) => ({
          ...rest,
          avg_market_share_pct: Math.round((market_share_sum / month_count) * 10) / 10,
        }))
        .sort((a, b) => a.quarter.localeCompare(b.quarter) || a.name.localeCompare(b.name));

      type SegmentRollup = {
        region: string;
        specialty: string;
        quarter: string;
        new_rx_count: number;
        total_rx_count: number;
        market_share_sum: number;
        month_count: number;
        hcps: Set<string>;
      };
      const bySegment = new Map<string, SegmentRollup>();
      for (const row of rows) {
        const hcp = hcpMap.get(row.hcp_id);
        if (!hcp) continue;
        const quarter = quarterKey(row.month);
        const key = `${hcp.region}|${hcp.specialty}|${quarter}`;
        const acc = bySegment.get(key) ?? {
          region: hcp.region,
          specialty: hcp.specialty,
          quarter,
          new_rx_count: 0,
          total_rx_count: 0,
          market_share_sum: 0,
          month_count: 0,
          hcps: new Set<string>(),
        };
        acc.new_rx_count += row.new_rx_count;
        acc.total_rx_count += row.total_rx_count;
        acc.market_share_sum += Number(row.market_share_pct);
        acc.month_count += 1;
        acc.hcps.add(hcp.id);
        bySegment.set(key, acc);
      }
      const segmentRollup = [...bySegment.values()]
        .map(({ market_share_sum, month_count, hcps: hcpSet, ...rest }) => ({
          ...rest,
          avg_market_share_pct: Math.round((market_share_sum / month_count) * 10) / 10,
          hcp_count: hcpSet.size,
        }))
        .sort((a, b) => a.region.localeCompare(b.region) || a.specialty.localeCompare(b.specialty) || a.quarter.localeCompare(b.quarter));

      return jsonText({ product: product.brand_name, segment_rollup: segmentRollup, hcp_quarterly: hcpQuarterly });
    }
  );

  server.tool(
    "hcp_visit_frequency_by_segment",
    "Quarterly rep interaction/visit frequency broken out by region and specialty — meant to be compared side by side with hcp_prescribing_trend_by_segment's segment_rollup for the same quarters.",
    {
      region: REGION.optional(),
      specialty: z.string().optional().describe("e.g. Oncology"),
      interaction_type: INTERACTION_TYPE.optional().describe("Omit to count all interaction types"),
      quarters_back: z.number().int().min(1).max(8).optional().default(2),
    },
    async ({ region, specialty, interaction_type, quarters_back }) => {
      let hq = supabase.from("hcps").select("id, region, specialty");
      if (region) hq = hq.eq("region", region);
      if (specialty?.trim()) hq = hq.ilike("specialty", specialty.trim());
      const { data: hcps, error: he } = await hq;
      if (he) throw new Error(he.message);
      if (!hcps?.length) return jsonText({ note: "No HCPs match the given region/specialty filter." });
      const hcpMap = new Map(hcps.map((h) => [h.id, h]));

      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - (quarters_back ?? 2) * 3);
      let q = supabase
        .from("hcp_interactions")
        .select("hcp_id, occurred_at, sentiment")
        .in(
          "hcp_id",
          hcps.map((h) => h.id)
        )
        .gte("occurred_at", cutoff.toISOString());
      if (interaction_type) q = q.eq("interaction_type", interaction_type);
      const { data: rows, error: ie } = await q;
      if (ie) throw new Error(ie.message);
      if (!rows?.length) return jsonText({ segment_rollup: [] });

      type Segment = { region: string; specialty: string; quarter: string; interaction_count: number; sentiment_sum: number; hcps: Set<string> };
      const bySegment = new Map<string, Segment>();
      for (const row of rows) {
        const hcp = hcpMap.get(row.hcp_id);
        if (!hcp) continue;
        const quarter = quarterKey(row.occurred_at);
        const key = `${hcp.region}|${hcp.specialty}|${quarter}`;
        const acc = bySegment.get(key) ?? {
          region: hcp.region,
          specialty: hcp.specialty,
          quarter,
          interaction_count: 0,
          sentiment_sum: 0,
          hcps: new Set<string>(),
        };
        acc.interaction_count += 1;
        acc.sentiment_sum += sentimentScore(row.sentiment);
        acc.hcps.add(row.hcp_id);
        bySegment.set(key, acc);
      }
      const segmentRollup = [...bySegment.values()]
        .map(({ sentiment_sum, hcps: hcpSet, interaction_count, ...rest }) => ({
          ...rest,
          interaction_count,
          hcps_engaged: hcpSet.size,
          avg_interactions_per_hcp: Math.round((interaction_count / hcpSet.size) * 10) / 10,
          avg_sentiment_score: Math.round((sentiment_sum / interaction_count) * 100) / 100,
        }))
        .sort((a, b) => a.region.localeCompare(b.region) || a.specialty.localeCompare(b.specialty) || a.quarter.localeCompare(b.quarter));

      return jsonText({ segment_rollup: segmentRollup });
    }
  );

  server.tool(
    "hcp_rep_activity",
    "Per-rep territory summary: HCPs engaged, total interactions, interactions in last 30 days, average sentiment.",
    {
      region: REGION.optional(),
      rep_name: z.string().optional().describe("Partial match on rep name"),
    },
    async ({ region, rep_name }) => {
      let q = supabase.from("v_rep_territory_summary").select("*").order("total_interactions", { ascending: false });
      if (region) q = q.eq("region", region);
      if (rep_name?.trim()) q = q.ilike("rep_name", `%${rep_name.trim()}%`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return jsonText({ rep_count: data?.length ?? 0, reps: data ?? [] });
    }
  );

  return server;
}
