import * as fs from "fs";
import * as path from "path";

/**
 * Attempts to resolve the entry point of a package located at `cwd`.
 * 1. Tries `require.resolve(cwd)`
 * 2. If that fails, reads `package.json` in `cwd` and:
 *    a) Tries `require.resolve(mainField, { paths: [cwd] })` (supports module identifiers)
 *    b) Tries `require.resolve(path.resolve(cwd, mainField))` (local file paths)
 * 3. Throws if all attempts fail
 */
export function resolveMain(cwd: string): string {
  // 1. Try default Node resolution
  try {
    return require.resolve(cwd);
  } catch {
    // ignore
  }

  // 2. Read package.json
  const pkgJsonPath = path.resolve(cwd, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(
      `Cannot resolve module at "${cwd}", and no package.json found at "${pkgJsonPath}"`,
    );
  }

  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch (err: any) {
    throw new Error(
      `Failed to read or parse package.json at "${pkgJsonPath}": ${err.message}`,
    );
  }

  const mainField = pkg.main;
  if (typeof mainField !== "string" || mainField.trim() === "") {
    throw new Error(
      `No valid "main" field in package.json at "${pkgJsonPath}"`,
    );
  }

  // 2a. If mainField is a module identifier
  try {
    return require.resolve(mainField, { paths: [cwd] });
  } catch {
    // ignore
  }

  // 2b. Treat mainField as a local path
  const mainFilePath = path.resolve(cwd, mainField);
  try {
    return require.resolve(mainFilePath);
  } catch (err: any) {
    throw new Error(
      `Cannot resolve "main" entry "${mainField}" (tried module specifier and file path "${mainFilePath}"): ${err.message}`,
    );
  }
}
