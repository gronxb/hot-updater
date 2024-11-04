import { readPackageUpSync } from "read-package-up";

export const packageJsonData = readPackageUpSync({
  cwd: __dirname,
});

export const version = packageJsonData?.packageJson.version;
