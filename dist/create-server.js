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
function quarterKey(dateStr) {
    const d = new Date(dateStr);
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return `${d.getUTCFullYear()}-Q${q}`;
}
function sentimentScore(sentiment) {
    return sentiment === "positive" ? 1 : sentiment === "negative" ? -1 : 0;
}
/** Shared MCP tool registrations for stdio and HTTP transports. */
export function createHcpServer(sql) {
    const server = new McpServer({
        name: "hcp-engagement",
        version: "1.0.0",
    });
    server.tool("hcp_list_hcps", "List Healthcare Professionals (HCPs). Filter by specialty, tier (A|B|C), region, or state. Mock data — not real providers.", {
        specialty: z.string().optional().describe("e.g. Cardiology, Oncology, Primary Care"),
        tier: TIER.optional(),
        region: REGION.optional(),
        state: z.string().optional().describe("Two-letter state code, e.g. NY"),
        limit: z.number().int().min(1).max(100).optional().default(50),
    }, async ({ specialty, tier, region, state, limit }) => {
        const data = await sql `
        SELECT id, npi, first_name, last_name, credentials, specialty, tier, institution, city, state, region
        FROM public.hcps
        WHERE is_active = true
          AND (${specialty?.trim() || null}::text IS NULL OR specialty ILIKE ${specialty?.trim() || null})
          AND (${tier ?? null}::text IS NULL OR tier = ${tier ?? null})
          AND (${region ?? null}::text IS NULL OR region = ${region ?? null})
          AND (${state?.trim() || null}::text IS NULL OR state ILIKE ${state?.trim() || null})
        ORDER BY tier, last_name
        LIMIT ${limit ?? 50}
      `;
        return jsonText({ hcp_count: data.length, hcps: data });
    });
    server.tool("hcp_search", "Search HCPs by name, NPI, or institution (partial match).", {
        query: z.string().min(1).describe("e.g. Nguyen, 1000000001, Boston Heart Institute"),
    }, async ({ query: qstr }) => {
        const term = `%${qstr.trim()}%`;
        const hcps = await sql `
        SELECT id, npi, first_name, last_name, credentials, specialty, tier, institution, city, state, region
        FROM public.hcps
        WHERE is_active = true
          AND (npi ILIKE ${term} OR last_name ILIKE ${term} OR first_name ILIKE ${term} OR institution ILIKE ${term})
      `;
        if (!hcps.length)
            return jsonText({ matches: [], note: "No HCPs match the query." });
        return jsonText({ matches: hcps.length, hcps });
    });
    server.tool("hcp_get_profile", "Full profile for one HCP by NPI: demographics, consent status per channel, and engagement summary.", {
        npi: z.string().min(1).describe("10-digit NPI, e.g. 1000000001"),
    }, async ({ npi }) => {
        const [hcp] = await sql `SELECT * FROM public.hcps WHERE npi = ${npi.trim()} LIMIT 1`;
        if (!hcp)
            return jsonText({ note: `No HCP found with NPI ${npi}.` });
        const [consents, summaries] = await Promise.all([
            sql `SELECT consent_type, status, updated_at FROM public.hcp_consents WHERE hcp_id = ${hcp.id}::uuid`,
            sql `SELECT * FROM public.v_hcp_engagement_summary WHERE hcp_id = ${hcp.id}::uuid LIMIT 1`,
        ]);
        return jsonText({ hcp, consents, engagement_summary: summaries[0] ?? null });
    });
    server.tool("hcp_list_interactions", "List rep-HCP interactions (visits, calls, emails). Filter by HCP NPI, region, specialty, rep name, interaction type, or how many days back.", {
        npi: z.string().optional().describe("Filter to one HCP by NPI"),
        region: REGION.optional(),
        specialty: z.string().optional().describe("e.g. Cardiology, Oncology"),
        rep_name: z.string().optional().describe("Partial match on rep name"),
        interaction_type: INTERACTION_TYPE.optional(),
        since_days: z.number().int().min(1).max(365).optional().default(90),
        limit: z.number().int().min(1).max(200).optional().default(50),
    }, async ({ npi, region, specialty, rep_name, interaction_type, since_days, limit }) => {
        const npiValue = npi?.trim() || null;
        const specialtyValue = specialty?.trim() || null;
        const repNameValue = rep_name?.trim() ? `%${rep_name.trim()}%` : null;
        if (npiValue || region || specialtyValue) {
            const hcps = await sql `
          SELECT id FROM public.hcps
          WHERE (${npiValue}::text IS NULL OR npi = ${npiValue})
            AND (${region ?? null}::text IS NULL OR region = ${region ?? null})
            AND (${specialtyValue}::text IS NULL OR specialty ILIKE ${specialtyValue})
          LIMIT 1
        `;
            if (!hcps.length)
                return jsonText({ interactions: [], note: "No HCPs match the given npi/region/specialty filter." });
        }
        if (repNameValue) {
            const reps = await sql `SELECT id FROM public.hcp_reps WHERE name ILIKE ${repNameValue} LIMIT 1`;
            if (!reps.length)
                return jsonText({ interactions: [], note: `No rep matches "${rep_name}".` });
        }
        const sinceDate = new Date(Date.now() - (since_days ?? 90) * 86400000).toISOString();
        const data = await sql `
        SELECT i.id, i.occurred_at, i.interaction_type, i.duration_minutes, i.sentiment, i.samples_left, i.notes,
          json_build_object('npi', h.npi, 'first_name', h.first_name, 'last_name', h.last_name, 'specialty', h.specialty, 'region', h.region) AS hcp,
          json_build_object('name', r.name, 'territory', r.territory) AS rep,
          COALESCE((SELECT json_agg(json_build_object('samples_qty', ip.samples_qty, 'materials_shared', ip.materials_shared,
            'key_message', ip.key_message, 'product', json_build_object('brand_name', p.brand_name)))
            FROM public.hcp_interaction_products ip JOIN public.hcp_products p ON p.id = ip.product_id
            WHERE ip.interaction_id = i.id), '[]'::json) AS products
        FROM public.hcp_interactions i
        JOIN public.hcps h ON h.id = i.hcp_id
        JOIN public.hcp_reps r ON r.id = i.rep_id
        WHERE i.occurred_at >= ${sinceDate}::timestamptz
          AND (${npiValue}::text IS NULL OR h.npi = ${npiValue})
          AND (${region ?? null}::text IS NULL OR h.region = ${region ?? null})
          AND (${specialtyValue}::text IS NULL OR h.specialty ILIKE ${specialtyValue})
          AND (${repNameValue}::text IS NULL OR r.id = (SELECT id FROM public.hcp_reps WHERE name ILIKE ${repNameValue} LIMIT 1))
          AND (${interaction_type ?? null}::text IS NULL OR i.interaction_type = ${interaction_type ?? null})
        ORDER BY i.occurred_at DESC
        LIMIT ${limit ?? 50}
      `;
        return jsonText({ interaction_count: data.length, interactions: data });
    });
    server.tool("hcp_engagement_summary", "Analytics: total interactions, recency, sentiment score, and samples per HCP. Sorted by most interactions first. Useful for finding engagement gaps (e.g. Tier A HCPs with no recent contact).", {
        tier: TIER.optional(),
        specialty: z.string().optional(),
        region: REGION.optional(),
        limit: z.number().int().min(1).max(100).optional().default(30),
    }, async ({ tier, specialty, region, limit }) => {
        const data = await sql `
        SELECT * FROM public.v_hcp_engagement_summary
        WHERE (${tier ?? null}::text IS NULL OR tier = ${tier ?? null})
          AND (${specialty?.trim() || null}::text IS NULL OR specialty ILIKE ${specialty?.trim() || null})
          AND (${region ?? null}::text IS NULL OR region = ${region ?? null})
        ORDER BY total_interactions DESC
        LIMIT ${limit ?? 30}
      `;
        return jsonText({ hcp_count: data.length, engagement: data });
    });
    server.tool("hcp_prescribing_trends", "Monthly prescribing trend (new Rx, total Rx, market share %) for an HCP, optionally scoped to one product. Requires npi.", {
        npi: z.string().min(1).describe("10-digit NPI, e.g. 1000000001"),
        brand_name: z.string().optional().describe("e.g. Cardiozin — omit for all products this HCP prescribes"),
        months_back: z.number().int().min(1).max(24).optional().default(6),
    }, async ({ npi, brand_name, months_back }) => {
        const [hcp] = await sql `SELECT id FROM public.hcps WHERE npi = ${npi.trim()} LIMIT 1`;
        if (!hcp)
            return jsonText({ trends: [], note: `No HCP found with NPI ${npi}.` });
        const sinceMonth = new Date();
        sinceMonth.setMonth(sinceMonth.getMonth() - (months_back ?? 6));
        const data = await sql `
        SELECT t.month, t.new_rx_count, t.total_rx_count, t.market_share_pct,
          json_build_object('brand_name', p.brand_name, 'generic_name', p.generic_name, 'therapeutic_area', p.therapeutic_area) AS product
        FROM public.hcp_prescribing_trends t JOIN public.hcp_products p ON p.id = t.product_id
        WHERE t.hcp_id = ${hcp.id}::uuid
          AND t.month >= ${sinceMonth.toISOString().slice(0, 10)}::date
          AND (${brand_name?.trim() || null}::text IS NULL OR lower(p.brand_name) = lower(${brand_name?.trim() || null}))
        ORDER BY t.month ASC
      `;
        return jsonText({ npi, trend_rows: data.length, trends: data });
    });
    server.tool("hcp_prescribing_trend_by_segment", "Quarterly prescribing trend for one product, broken out by region and specialty (segment_rollup), plus per-HCP quarterly rows (hcp_quarterly) for drill-down into which specific HCPs are declining/growing. Use segment_rollup to compare regions/specialties side by side; use hcp_quarterly to find individual decliners within a flagged segment.", {
        brand_name: z.string().min(1).describe("e.g. Oncovarin"),
        region: REGION.optional(),
        specialty: z.string().optional().describe("e.g. Oncology"),
        quarters_back: z.number().int().min(1).max(8).optional().default(2),
    }, async ({ brand_name, region, specialty, quarters_back }) => {
        const [product] = await sql `
        SELECT id, brand_name FROM public.hcp_products WHERE brand_name ILIKE ${`%${brand_name.trim()}%`}
        LIMIT 1
      `;
        if (!product)
            return jsonText({ note: `No product matches "${brand_name}".` });
        const hcps = await sql `
        SELECT id, npi, first_name, last_name, region, specialty, tier FROM public.hcps
        WHERE (${region ?? null}::text IS NULL OR region = ${region ?? null})
          AND (${specialty?.trim() || null}::text IS NULL OR specialty ILIKE ${specialty?.trim() || null})
      `;
        if (!hcps.length)
            return jsonText({ note: "No HCPs match the given region/specialty filter." });
        const hcpMap = new Map(hcps.map((h) => [h.id, h]));
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - (quarters_back ?? 2) * 3);
        const rows = await sql `
        SELECT hcp_id, month::text, new_rx_count, total_rx_count, market_share_pct
        FROM public.hcp_prescribing_trends
        WHERE product_id = ${product.id}::uuid
          AND hcp_id = ANY(${hcps.map((hcp) => hcp.id)}::uuid[])
          AND month >= ${cutoff.toISOString().slice(0, 10)}::date
        ORDER BY month ASC
      `;
        if (!rows.length)
            return jsonText({ product: product.brand_name, segment_rollup: [], hcp_quarterly: [] });
        const byHcpQuarter = new Map();
        for (const row of rows) {
            const hcp = hcpMap.get(row.hcp_id);
            if (!hcp)
                continue;
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
        const bySegment = new Map();
        for (const row of rows) {
            const hcp = hcpMap.get(row.hcp_id);
            if (!hcp)
                continue;
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
                hcps: new Set(),
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
    });
    server.tool("hcp_visit_frequency_by_segment", "Quarterly rep interaction/visit frequency broken out by region and specialty — meant to be compared side by side with hcp_prescribing_trend_by_segment's segment_rollup for the same quarters.", {
        region: REGION.optional(),
        specialty: z.string().optional().describe("e.g. Oncology"),
        interaction_type: INTERACTION_TYPE.optional().describe("Omit to count all interaction types"),
        quarters_back: z.number().int().min(1).max(8).optional().default(2),
    }, async ({ region, specialty, interaction_type, quarters_back }) => {
        const hcps = await sql `
        SELECT id, region, specialty FROM public.hcps
        WHERE (${region ?? null}::text IS NULL OR region = ${region ?? null})
          AND (${specialty?.trim() || null}::text IS NULL OR specialty ILIKE ${specialty?.trim() || null})
      `;
        if (!hcps.length)
            return jsonText({ note: "No HCPs match the given region/specialty filter." });
        const hcpMap = new Map(hcps.map((h) => [h.id, h]));
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - (quarters_back ?? 2) * 3);
        const rows = await sql `
        SELECT hcp_id, occurred_at, sentiment FROM public.hcp_interactions
        WHERE hcp_id = ANY(${hcps.map((hcp) => hcp.id)}::uuid[])
          AND occurred_at >= ${cutoff.toISOString()}::timestamptz
          AND (${interaction_type ?? null}::text IS NULL OR interaction_type = ${interaction_type ?? null})
      `;
        if (!rows.length)
            return jsonText({ segment_rollup: [] });
        const bySegment = new Map();
        for (const row of rows) {
            const hcp = hcpMap.get(row.hcp_id);
            if (!hcp)
                continue;
            const quarter = quarterKey(row.occurred_at);
            const key = `${hcp.region}|${hcp.specialty}|${quarter}`;
            const acc = bySegment.get(key) ?? {
                region: hcp.region,
                specialty: hcp.specialty,
                quarter,
                interaction_count: 0,
                sentiment_sum: 0,
                hcps: new Set(),
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
    });
    server.tool("hcp_rep_activity", "Per-rep territory summary: HCPs engaged, total interactions, interactions in last 30 days, average sentiment.", {
        region: REGION.optional(),
        rep_name: z.string().optional().describe("Partial match on rep name"),
    }, async ({ region, rep_name }) => {
        const data = await sql `
        SELECT * FROM public.v_rep_territory_summary
        WHERE (${region ?? null}::text IS NULL OR region = ${region ?? null})
          AND (${rep_name?.trim() ? `%${rep_name.trim()}%` : null}::text IS NULL OR rep_name ILIKE ${rep_name?.trim() ? `%${rep_name.trim()}%` : null})
        ORDER BY total_interactions DESC
      `;
        return jsonText({ rep_count: data.length, reps: data });
    });
    return server;
}
