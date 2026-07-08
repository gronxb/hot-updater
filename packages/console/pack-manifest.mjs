import { readFile, rm, writeFile } from "node:fs/promises";

const manifestUrl = new URL("./package.json", import.meta.url);
const backupUrl = new URL("./package.json.pack-backup", import.meta.url);

const readManifest = async () =>
  JSON.parse(await readFile(manifestUrl, "utf8"));

const writeManifest = async (manifest) => {
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
};

const prepare = async () => {
  const manifest = await readManifest();
  await writeManifestToUrl(backupUrl, manifest);

  delete manifest.devDependencies;

  if (manifest.scripts) {
    delete manifest.scripts.prepack;
    delete manifest.scripts.postpack;
  }

  await writeManifest(manifest);
};

const restore = async () => {
  let backup;
  try {
    backup = JSON.parse(await readFile(backupUrl, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await writeManifest(backup);
  await rm(backupUrl);
};

const writeManifestToUrl = async (url, manifest) => {
  await writeFile(url, `${JSON.stringify(manifest, null, 2)}\n`);
};

const command = process.argv[2];

if (command === "prepare") {
  await prepare();
} else if (command === "restore") {
  await restore();
} else {
  throw new Error(`Unknown pack-manifest command: ${command ?? ""}`);
}
