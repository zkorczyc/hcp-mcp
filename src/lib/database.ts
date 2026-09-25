import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { requireEnv } from "./env.js";

export type DatabaseClient = NeonQueryFunction<false, false>;

export function getDatabase(): DatabaseClient {
  return neon(requireEnv("DATABASE_URL"));
}