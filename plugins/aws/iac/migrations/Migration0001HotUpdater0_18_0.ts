import { merge } from "es-toolkit";
import { S3Migration } from "./migrator";

/**
 * Migration0001HotUpdater0_18_0
 * Adds storageUri to all update.json files.
 */
export class Migration0001HotUpdater0_18_0 extends S3Migration {
  name = "hot-updater_0.18.0";

  async migrate(): Promise<void> {
    const keys = await this.getKeys("");
    const updateKeys = keys.filter((key) => key.endsWith("update.json"));

    for (const key of updateKeys) {
      const data = await this.readJson<{ fileUrl: string }[]>(key);
      if (data && Array.isArray(data)) {
        const updatedData = data.map((item) =>
          merge(item, { storageUri: item.fileUrl }),
        );
        await this.updateFile(key, JSON.stringify(updatedData));
      }
    }
  }
}
