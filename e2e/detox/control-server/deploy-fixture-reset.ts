import fs from "node:fs/promises";

export type DeployFixtureBackup = {
  backupPath: string | null;
  targetPath: string;
};

export async function restoreDeployFixtures(
  fixtures: readonly DeployFixtureBackup[],
): Promise<void> {
  for (const fixture of fixtures) {
    if (fixture.backupPath) {
      await fs.copyFile(fixture.backupPath, fixture.targetPath);
    } else {
      await fs.rm(fixture.targetPath, { force: true });
    }
  }
}
