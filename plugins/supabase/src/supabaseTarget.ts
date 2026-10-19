/**
 * The Supabase project a `supabaseDatabase` reaches, which the provider's
 * `./init` reads to migrate the project hot-updater.config.ts names. A
 * registered symbol, so the init's own copy of this module reads the
 * config's.
 */
const SUPABASE_TARGET = Symbol.for("@hot-updater/supabase/project");

export interface SupabaseTarget {
  readonly supabaseUrl: string;
}

/** `database` with the project it reaches, as `supabaseDatabase` marks it. */
export const withSupabaseTarget = <T extends object>(
  database: T,
  { supabaseUrl }: SupabaseTarget,
) =>
  Object.defineProperty(database, SUPABASE_TARGET, {
    value: { supabaseUrl },
  }) as T;

/** The project `database` reaches; undefined unless `supabaseDatabase` made it. */
export const supabaseTargetOf = (
  database: unknown,
): SupabaseTarget | undefined =>
  typeof database === "object" && database !== null
    ? (Reflect.get(database, SUPABASE_TARGET) as SupabaseTarget | undefined)
    : undefined;
