#!/usr/bin/env node
import Pastel from "pastel";
const app = new Pastel({
    importMeta: import.meta,
    name: "hot-updater",
});
await app.run();
