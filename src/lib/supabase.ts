import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";

export function getSupabaseClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
