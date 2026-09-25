import { type NeonQueryFunction } from "@neondatabase/serverless";
export type DatabaseClient = NeonQueryFunction<false, false>;
export declare function getDatabase(): DatabaseClient;
