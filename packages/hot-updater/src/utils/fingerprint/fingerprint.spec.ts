import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe } from "vitest";

const tmpDir = path.resolve(os.tmpdir(), ".hot-updater“, ”test");
// const iosDir = path.resolve(tmpDir, "ios");

describe.skip("Fingerprint", () => {
  beforeEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });

    const exampleExpo52 = path.resolve(process.cwd(), "../../examples/expo-52");
    for (const file of fs.readdirSync(exampleExpo52)) {
      if (file !== "node_modules") {
        console.log(file);
        const filePath = path.resolve(exampleExpo52, file);
        const isDir = fs.statSync(filePath).isDirectory();
        fs.cpSync(filePath, path.resolve(tmpDir), {
          recursive: isDir,
        });
      }
    }
  });
});
