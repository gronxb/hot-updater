#!/usr/bin/env node

// src/cli.tsx
import Pastel from "pastel";
var app = new Pastel({
  importMeta: import.meta,
  name: "hot-updater",
  version: "0.0.1"
});
await app.run();
