const express = require("express");
const { createHotUpdater } = require("@hot-updater/server");
const { kyselyAdapter } = require("@hot-updater/server/adapters/kysely");
const { toNodeHandler } = require("@hot-updater/server/node");
const { apiKeys } = require("@hot-updater/server/plugins/api-keys");
const { insights } = require("@hot-updater/server/plugins/insights");

const { db } = require("./db");

const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db, provider: "postgresql" }),
  plugins: [insights(), apiKeys()],
});

const app = express();
app.use("/hot-updater", toNodeHandler(hotUpdater.handlers.client));

module.exports = { app, hotUpdater };
