import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("src/embedded.d.ts", "dist/embedded.d.ts");
await copyFile("src/embedded.css", "dist/embedded.css");
await copyFile("src/lib/server/hosted.d.ts", "dist/hosted.d.ts");
