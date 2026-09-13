import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

function chunk(name, bytes) {
  const body = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

export async function finishSpike(outDir, framework, variant, provenance) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const pixel = variant === "A" ? [30, 104, 220] : [224, 66, 45];
  const pixels = Buffer.from(
    Array.from({ length: 8 }, () => [
      0,
      ...Array.from({ length: 8 }, () => pixel).flat(),
    ]).flat(),
  );
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await fs.mkdir(path.join(outDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(outDir, "assets/probe.png"), png);
  if (["dynamic", "sdk2", "sdk3"].includes(provenance.resourceSet)) {
    const { stdout, stderr } = await promisify(execFile)(
      "pnpm",
      [
        "exec",
        "rspeedy",
        "build",
        "--config",
        "spike/dynamic.config.ts",
        "--environment",
        "lynx",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          HOT_UPDATER_SPIKE_VARIANT: variant,
          HOT_UPDATER_DYNAMIC_DIR: path.join(outDir, "dynamic"),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  if (
    provenance.resourceSet === "external" ||
    provenance.resourceSet === "external2" ||
    provenance.resourceSet === "sdk2" ||
    provenance.resourceSet === "sdk3"
  ) {
    const { buildExternalBootstrap } = await import("./external-bootstrap.mjs");
    await buildExternalBootstrap(outDir, variant);
  }
  if (
    provenance.resourceSet !== "basic" &&
    provenance.resourceSet !== "http" &&
    provenance.resourceSet !== "sdk1"
  ) {
    const fonts = fileURLToPath(new URL("../spike/fonts/", import.meta.url));
    await fs.copyFile(
      path.join(
        fonts,
        variant === "A" ? "Inter-Regular.ttf" : "Inter-Black.ttf",
      ),
      path.join(outDir, "assets/probe.ttf"),
    );
    await fs.copyFile(
      path.join(fonts, "OFL.txt"),
      path.join(outDir, "assets/OFL.txt"),
    );
  }
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else {
        const bytes = await fs.readFile(absolute);
        files.push({
          path: path.relative(outDir, absolute),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(outDir);
  // Evidence is outside the artifact: it cannot accidentally be shipped as metadata.
  const report = {
    framework,
    variant,
    entry: "main.lynx.bundle",
    provenance,
    files,
  };
  await fs.writeFile(
    `${outDir}.build.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
