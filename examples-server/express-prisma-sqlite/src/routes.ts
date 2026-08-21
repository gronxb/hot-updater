import { toNodeHandler } from "@hot-updater/server/node";
import cors from "cors";
import express from "express";
import type { Router } from "express";

import { hotUpdater } from "./db";

const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;

if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required.");

export function setupRoutes(router: Router) {
  router.use(
    "/hot-updater/admin",
    (req, res, next) => {
      if (req.get("Authorization") !== `Bearer ${adminToken}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      next();
    },
    express.json({ limit: "1mb" }),
    toNodeHandler(hotUpdater.handlers.admin),
  );
  router.use(
    "/hot-updater",
    cors(),
    express.json({ limit: "1mb" }),
    toNodeHandler(hotUpdater.handlers.client),
  );
}
