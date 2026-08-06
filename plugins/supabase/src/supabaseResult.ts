import type { PostgrestError } from "@supabase/supabase-js";

export class SupabaseDatabaseError extends Error {
  readonly name = "SupabaseDatabaseError";

  constructor(
    readonly operation: string,
    cause: PostgrestError,
  ) {
    super(`Supabase database operation failed: ${operation}`, { cause });
  }
}

export class SupabaseMissingDataError extends Error {
  readonly name = "SupabaseMissingDataError";

  constructor(readonly operation: string) {
    super(`Supabase database operation returned no row: ${operation}`);
  }
}

export const throwSupabaseError = (
  operation: string,
  error: PostgrestError | null,
): void => {
  if (error !== null) {
    throw new SupabaseDatabaseError(operation, error);
  }
};
