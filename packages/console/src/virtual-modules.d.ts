declare module "virtual:hot-updater-console/auth" {
  import type { ConsoleAuthAdapter } from "./index";

  const auth: ConsoleAuthAdapter;
  export default auth;
}

declare module "virtual:hot-updater-console/config" {
  import type { HotUpdaterConsoleConfigSource } from "./index";

  const config: HotUpdaterConsoleConfigSource;
  export default config;
}

declare module "virtual:hot-updater-console/package-router" {
  export { getRouter } from "./router";
}

declare module "virtual:hot-updater-console/route-tree" {
  export { routeTree } from "./routeTree.gen";
}
