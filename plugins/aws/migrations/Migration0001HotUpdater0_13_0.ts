import { merge, omit } from "es-toolkit";
import { S3Migration } from "./migrator";

/**
 * Migration0001HotUpdater0_13_0
 * 1. Moves all files starting with ios/ or android/ to under production/ directory.
 * 2. Reads update.json files in the production/ path, removes the fileUrl property from each item, merges { channel: "production" }, and updates them.
 */
export class Migration0001HotUpdater0_13_0 extends S3Migration {
  name = "hot-updater_0.13.0";

  async migrate(): Promise<void> {
    // Step 1: Move all files starting with ios/ or android/ to under production/ directory
    const keysToMove = (await this.getKeys("")).filter(
      (key) => !key.startsWith("production/") && /^(ios|android)\//.test(key),
    );

    for (const key of keysToMove) {
      const newKey = `production/${key}`;
      await this.moveFile(key, newKey);
    }

    // Step 2: Update update.json files in the production/ path
    const productionKeys = await this.getKeys("production/");
    const updateKeys = productionKeys.filter((key) =>
      key.endsWith("update.json"),
    );

    for (const key of updateKeys) {
      const data = await this.readJson<{ fileUrl: string }[]>(key);
      if (data && Array.isArray(data)) {
        const updatedData = data.map((item) =>
          merge(omit(item, ["fileUrl"]), { channel: "production" }),
        );
        await this.updateFile(key, JSON.stringify(updatedData), {
          cacheControl: "no-cache",
        });
      }
    }
  }
}
