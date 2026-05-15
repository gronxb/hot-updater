import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const packageJsonData = require("../package.json") as {
  version?: string;
};

export const version = packageJsonData.version;
