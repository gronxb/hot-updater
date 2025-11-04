import type { Router } from "express";
import { toNodeHandler } from "@hot-updater/server/node";
import { hotUpdater } from "./db";

export function setupRoutes(router: Router) {
  // Mount Hot Updater handler using toNodeHandler adapter
  router.all("/hot-updater/*", toNodeHandler(hotUpdater));
}
