import { findPackageRoot } from "workspace-tools";
export const getCwd = () => findPackageRoot(process.cwd());
