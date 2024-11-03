import { fileURLToPath } from "url";

import { readPackageUpSync } from "read-package-up";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const packageJsonData = readPackageUpSync({
  cwd: __dirname,
});

export const version = packageJsonData?.packageJson.version;
