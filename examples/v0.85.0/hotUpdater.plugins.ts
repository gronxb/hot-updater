// The plugins the managed servers run, as `hot-updater init` writes them for a
// managed provider. Every managed package ships the same list, so this file
// serves each managed e2e profile: the CLI and the e2e controller read Insights
// through it. A standaloneRepository's server runs its own plugins.
export { plugins } from "@hot-updater/cloudflare";
