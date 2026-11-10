// The workspace-tools index also loads its lockfile parsers, which bundle
// @yarnpkg/lockfile and its old minimatch copy.
import { findPackageRoot } from "workspace-tools/lib/paths.js";

export const getCwd = () => findPackageRoot(process.cwd()) ?? process.cwd();
