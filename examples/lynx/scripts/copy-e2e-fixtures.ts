import fs from "node:fs/promises";
import path from "node:path";

export async function copyE2eFixtures(
  cwd: string,
  outDir: string,
): Promise<void> {
  const srcDir = path.join(cwd, "src/test");
  let names: string[];
  try {
    names = await fs.readdir(srcDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const destDir = path.join(outDir, "assets/src/test");
  const androidRawDir = path.join(outDir, "raw");
  await fs.mkdir(destDir, { recursive: true });
  await fs.mkdir(androidRawDir, { recursive: true });
  for (const name of names) {
    if (!name.startsWith("_fixture-")) {
      continue;
    }
    await fs.copyFile(path.join(srcDir, name), path.join(destDir, name));
    await fs.copyFile(
      path.join(srcDir, name),
      path.join(androidRawDir, `src_test_${name.replaceAll("-", "")}`),
    );
  }
}
