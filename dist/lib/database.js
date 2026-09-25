import { neon } from "@neondatabase/serverless";
import { requireEnv } from "./env.js";
export function getDatabase() {
    return neon(requireEnv("DATABASE_URL"));
}
