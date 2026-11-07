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

declare module "virtual:hot-updater-console/request-guard" {
  /**
   * The local console's request guard: a refusal or redirect to answer
   * with, or undefined to let the request through. A hosted console has
   * none.
   */
  const guard:
    | ((
        request: Request,
      ) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  export default guard;
}

declare module "virtual:hot-updater-console/package-start" {
  export { startInstance } from "./start";
}
