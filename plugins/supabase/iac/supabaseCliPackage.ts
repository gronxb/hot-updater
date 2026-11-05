/**
 * The Supabase CLI init runs, as `npx -y <SUPABASE_CLI>`, so whichever CLI
 * the project installs or npx resolves can't change what its commands do.
 * Supabase CLI 3 sends `db push` and `migration fetch` without a target to
 * the local stack, and fails a hosted change without a terminal unless
 * `--yes` is passed: moving to it means passing those flags.
 */
export const SUPABASE_CLI = "supabase@2.122.1";
