/**
 * Whether a command stopped at the schema fence. Its message says what to
 * do, so the CLI prints it as one line, without a stack. Matched by name: the
 * config's database adapter may load another copy of plugin-core.
 */
export const isSchemaFenceRefusal = (error: unknown): error is Error =>
  error instanceof Error &&
  error.name === "HotUpdaterSchemaMigrationRequiredError";
