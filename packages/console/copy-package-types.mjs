import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("src/embedded.d.ts", "dist/embedded.d.ts");
await copyFile("src/lib/server/hosted.d.ts", "dist/hosted.d.ts");
