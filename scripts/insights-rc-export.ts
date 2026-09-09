import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const metadataFields = [
  "username", "cohort", "update_strategy", "fingerprint_hash", "sdk_version",
] as const;

/** Offline RC export conversion only. The normal record boundary validates replay. */
export function normalizeInsightsRcEvent(value: Record<string, unknown>) {
  if ("metadata" in value) {
    if (metadataFields.some((field) => field in value)) {
      throw new Error("Mixed event metadata and legacy columns; inspect the export.");
    }
    return value;
  }
  const event = { ...value };
  const metadata: Record<string, unknown> = {};
  for (const field of metadataFields) {
    if (!(field in event)) throw new Error(`Missing legacy event field: ${field}`);
    metadata[field] = event[field];
    delete event[field];
  }
  return { ...event, metadata };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error("Usage: node --experimental-strip-types scripts/insights-rc-export.ts input.ndjson output.ndjson");
  // Never overwrite a backup. A failed conversion leaves an incomplete output
  // for inspection; discard it and retry with a new path before any replay.
  const writer = createWriteStream(output, { flags: "wx" });
  const finished = once(writer, "finish");
  await once(writer, "open");
  const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = normalizeInsightsRcEvent(JSON.parse(line));
    if (!writer.write(`${JSON.stringify(row)}\n`)) await once(writer, "drain");
  }
  writer.end();
  await finished;
}
