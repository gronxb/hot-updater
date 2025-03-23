import { merge, omit } from "es-toolkit";
import picocolors from "picocolors";
import { S3Migration } from "./migrator";

/**
 * Migration0001HotUpdater0_13_0
 * 1. Retrieves all keys in the bucket.
 * 2. If update.json exists, reads the JSON array, removes the fileUrl property from each item,
 *    and merges in { channel: "production" } before updating the file.
 * 3. Moves files that start with ios/ or android/ under the production/ prefix.
 */
export class Migration0001HotUpdater0_13_0 extends S3Migration {
  name = "hot-updater_0.13.0";

  async migrate(): Promise<void> {
    // Retrieve all keys in the bucket
    const keys = await this.getKeys("");
    console.log(picocolors.blue("All keys in bucket:"), keys);

    // Process update.json (which is expected to be an array)
    for (const key of keys) {
      if (key.endsWith("update.json")) {
        const data = await this.readJson<{ fileUrl: string }[]>(key);
        if (data) {
          const updatedData = data.map((item) =>
            merge(omit(item, ["fileUrl"]), { channel: "production" }),
          );
          await this.updateFile(
            "update.json",
            JSON.stringify(updatedData, null, 2),
          );
          console.log(picocolors.green("update.json updated successfully."));
        } else {
          console.log(
            picocolors.yellow("update.json does not contain an array."),
          );
        }
      }
    }

    // Move files that start with ios/ or android/ to the production/ prefix
    for (const key of keys) {
      if (key.startsWith("production/")) {
        continue;
      }
      if (/^(ios|android)\//.test(key)) {
        const newKey = `production/${key}`;
        await this.moveFile(key, newKey);
      }
    }
  }
}
