import { merge, omit } from "es-toolkit";
import picocolors from "picocolors";
import { S3Migration } from "./migrator";

/**
 * Migration0001HotUpdater0_13_0
 * 1. ios/ 또는 android/로 시작하는 모든 파일을 production/ 하위로 이동합니다.
 * 2. production/ 경로에 있는 update.json 파일을 읽어, 각 항목에서 fileUrl 프로퍼티를 제거하고 { channel: "production" }을 병합한 후 업데이트합니다.
 */
export class Migration0001HotUpdater0_13_0 extends S3Migration {
  name = "hot-updater_0.13.0";

  async migrate(): Promise<void> {
    // Step 1: ios/ 또는 android/로 시작하는 모든 파일을 production/ 하위로 이동합니다.
    const keysToMove = (await this.getKeys("")).filter(
      (key) => !key.startsWith("production/") && /^(ios|android)\//.test(key),
    );
    console.log(picocolors.blue("Keys to move:"), keysToMove);

    for (const key of keysToMove) {
      const newKey = `production/${key}`;
      await this.moveFile(key, newKey);
    }

    // Step 2: production/ 경로에 있는 update.json 파일들을 업데이트합니다.
    const productionKeys = await this.getKeys("production/");
    const updateKeys = productionKeys.filter((key) =>
      key.endsWith("update.json"),
    );
    console.log(picocolors.blue("Production update keys:"), updateKeys);

    for (const key of updateKeys) {
      try {
        const data = await this.readJson<{ fileUrl: string }[]>(key);
        if (data && Array.isArray(data)) {
          const updatedData = data.map((item) =>
            merge(omit(item, ["fileUrl"]), { channel: "production" }),
          );
          await this.updateFile(key, JSON.stringify(updatedData));
          console.log(
            picocolors.green(`update.json updated successfully for ${key}.`),
          );
        } else {
          console.log(
            picocolors.yellow(
              `update.json in ${key} does not contain an array.`,
            ),
          );
        }
      } catch (error) {
        console.error(picocolors.red(`Error processing ${key}: ${error}`));
      }
    }
  }
}
