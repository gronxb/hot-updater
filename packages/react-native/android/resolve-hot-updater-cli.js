// Prints the path of the hot-updater CLI the app root given as the first
// argument resolves. hot-updater-fingerprint.gradle runs this file rather than
// an inline `node -e` script, so no code passes through the command line,
// which Windows quotes differently from macOS and Linux.
const path = require("node:path");

const manifest = require.resolve("hot-updater/package.json", {
  paths: [process.argv[2]],
});
const { bin } = require(manifest);
console.log(
  path.join(
    path.dirname(manifest),
    typeof bin === "string" ? bin : bin["hot-updater"],
  ),
);
