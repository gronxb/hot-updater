import { findPackageRoot } from "workspace-tools";

export const cwd = () => findPackageRoot(process.cwd())!;
