#!/usr/bin/env node
import Pastel from "pastel";

const app = new Pastel({
  importMeta: import.meta,
  name: "hot-updater",
  version: process.env["VERSION"],
});

await app.run();
