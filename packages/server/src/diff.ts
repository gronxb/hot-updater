/**
 * Bundle diffs for patch artifacts. They run bsdiff's WebAssembly, so they
 * have their own entry: `@hot-updater/server/db` stays loadable where that
 * module cannot load, such as a console on Cloudflare Workers.
 */
export * from "./db/createBundleDiff";
