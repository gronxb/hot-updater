import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [receiptPath, framework, slot, serial = "emulator-5558"] = process.argv.slice(2);
if (!receiptPath || !["react", "vue", "octane"].includes(framework) || !/^[\w-]+$/.test(slot ?? "")) {
  throw new Error("Usage: node stage-fixture.mjs <receipt.json> <framework> <slot> [serial]");
}
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const root = fs.realpathSync(receipt.buildPath);
function copy(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) copy(file);
    else if (entry.isFile()) {
      const relative = path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/");
      execFileSync("adb", ["-s", serial, "shell", "content", "write", "--uri",
        `content://com.hotupdater.lynxexample.staging/${framework}/${slot}/${relative}`],
      { input: fs.readFileSync(file), stdio: ["pipe", "inherit", "inherit"] });
    } else throw new Error(`Unsupported staging input: ${file}`);
  }
}
copy(root);
console.log(JSON.stringify({ framework, slot, bundleId: receipt.bundleId, releaseId: receipt.releaseId }));
