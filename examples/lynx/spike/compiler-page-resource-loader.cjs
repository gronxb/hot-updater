const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const { deflateSync } = require("node:zlib");

const exampleRoot = path.resolve(__dirname, "..");

function pngChunk(name, bytes) {
  const body = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function probePng(variant) {
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
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function buildResource(kind, variant) {
  if (kind === "probe") {
    return [["assets/probe.png", probePng(variant), true]];
  }
  if (kind === "font") {
    const fontRoot = path.join(exampleRoot, "spike/fonts");
    const stableFont = process.env.HOT_UPDATER_SPIKE_STABLE_FONT === "1";
    return [
      [
        "assets/probe.ttf",
        await fs.readFile(
          path.join(
            fontRoot,
            stableFont || variant === "A"
              ? "Inter-Regular.ttf"
              : "Inter-Black.ttf",
          ),
        ),
        true,
      ],
      [
        "assets/OFL.txt",
        await fs.readFile(path.join(fontRoot, "OFL.txt")),
        false,
      ],
    ];
  }
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), `hot-updater-lynx-${kind}-`),
  );
  try {
    if (kind === "bootstrap") {
      const { buildExternalBootstrap } = await import(
        pathToFileURL(path.join(exampleRoot, "scripts/external-bootstrap.mjs"))
      );
      await buildExternalBootstrap(temporary, variant);
      return [
        [
          "assets/bootstrap.js",
          await fs.readFile(path.join(temporary, "assets/bootstrap.js")),
          true,
        ],
      ];
    }
    if (kind === "dynamic") {
      const dynamicRoot = path.join(temporary, "dynamic");
      await promisify(execFile)(
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
          cwd: exampleRoot,
          env: {
            ...process.env,
            HOT_UPDATER_DYNAMIC_DIR: dynamicRoot,
            HOT_UPDATER_SPIKE_VARIANT: variant,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return [
        [
          "dynamic/component.lynx.bundle",
          await fs.readFile(path.join(dynamicRoot, "component.lynx.bundle")),
          true,
        ],
      ];
    }
    throw new Error(`Unknown compiler page resource: ${kind}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = function compilerPageResourceLoader(source) {
  const callback = this.async();
  const variant = process.env.HOT_UPDATER_SPIKE_VARIANT ?? "A";
  let descriptor;
  try {
    descriptor = JSON.parse(source.toString());
  } catch (error) {
    callback(error);
    return;
  }
  buildResource(descriptor.kind, variant).then((assets) => {
    for (const [name, bytes, essential] of assets) {
      this.emitFile(name, bytes, undefined, {
        hotUpdaterPageEssential: essential,
        sourceFilename: this.resourcePath,
      });
    }
    callback(null, "export {};\n");
  }, callback);
};
