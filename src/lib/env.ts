export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}. See .env.example`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}
