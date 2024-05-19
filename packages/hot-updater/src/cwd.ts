import { findPackageRoot } from "workspace-tools";

// biome-ignore lint/style/noNonNullAssertion: <explanation>
export const cwd = () => findPackageRoot(process.cwd())!;
