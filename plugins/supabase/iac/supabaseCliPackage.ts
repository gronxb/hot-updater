/**
 * The Supabase CLI init runs, as `npx -y <SUPABASE_CLI>`, so whichever CLI
 * the project installs or npx resolves can't change what its commands do.
 * Its commands use Supabase CLI 3's forms: `--remote` targets the linked
 * project or `--remote=<ref>` another one, and every hosted change passes
 * `--yes`, because CLI 3 fails one without a terminal unless it does. Move
 * to a new major only after checking each command against its release notes.
 */
export const SUPABASE_CLI = "supabase@3.0.0";
