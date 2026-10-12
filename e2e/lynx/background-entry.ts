import fs from "node:fs/promises";
import path from "node:path";

/** Deployed script identity is compiled into authenticated bytes, never supplied by the OS trigger. */
export async function writeLynxBackgroundEntry(
  outDir: string,
  identity: { readonly bundleId: string; readonly marker: string },
): Promise<string> {
  const entry = "background-task.js";
  const source = `({ init({ tt }) {
  tt.NativeModules.HotUpdaterBackground.complete(JSON.stringify(${JSON.stringify(identity)}));
} });\n`;
  await fs.writeFile(path.join(outDir, entry), source);
  return entry;
}
