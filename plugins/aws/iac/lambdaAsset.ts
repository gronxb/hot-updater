import path from "path";

/**
 * Resolves the directory holding the bundled Lambda@Edge runtime.
 * Kept in its own module so it can be mocked in tests without requiring a
 * built `dist/`.
 */
export const resolveLambdaDir = () =>
  path.dirname(require.resolve("@hot-updater/aws/lambda"));
