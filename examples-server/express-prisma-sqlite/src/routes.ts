import { toNodeHandler } from "@hot-updater/server/node";
import type { Request, Router } from "express";
import { hotUpdater } from "./db";

const authorizeBundleRequest = (req: Request) => {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const token = process.env.HOT_UPDATER_AUTH_TOKEN;
  return Boolean(token) && req.get("Authorization") === `Bearer ${token}`;
};

export function setupRoutes(router: Router) {
  // Mount Hot Updater handler using toNodeHandler adapter
  router.use("/hot-updater/api", (req, res, next) => {
    if (!authorizeBundleRequest(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  });
  router.all("/hot-updater/*", toNodeHandler(hotUpdater));
}
