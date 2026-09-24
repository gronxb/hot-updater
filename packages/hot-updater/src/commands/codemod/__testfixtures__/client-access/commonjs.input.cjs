const express = require("express");
const { createHotUpdater } = require("@hot-updater/server");
const { kyselyAdapter } = require("@hot-updater/server/adapters/kysely");
const { toNodeHandler } = require("@hot-updater/server/node");

const { db } = require("./db");

const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db, provider: "postgresql" }),
  clientAccess: { type: "api-key" },
});

const app = express();
app.use("/hot-updater", toNodeHandler(hotUpdater.handlers.client));

module.exports = { app, hotUpdater };
