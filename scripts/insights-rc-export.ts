import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const metadataFields = [
  "username",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
] as const;

/** Offline RC export conversion only. The normal record boundary validates replay. */
export function normalizeInsightsRcEvent(value: Record<string, unknown>) {
  let event: Record<string, unknown>;
  if ("metadata" in value) {
    if (metadataFields.some((field) => field in value)) {
      throw new Error(
        "Mixed event metadata and legacy columns; inspect the export.",
      );
    }
    event = { ...value };
  } else {
    event = { ...value };
    const metadata: Record<string, unknown> = {};
    for (const field of metadataFields) {
      if (!(field in event))
        throw new Error(`Missing legacy event field: ${field}`);
      metadata[field] = event[field];
      delete event[field];
    }
    event.metadata = metadata;
  }
  if (event.type === "RELEASE_ADOPTED") {
    const metadata = event.metadata as Record<string, unknown>;
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      "rc_legacy_event" in metadata ||
      !("from_bundle_id" in event) ||
      !("update_strategy" in metadata)
    ) {
      throw new Error("Ambiguous legacy release adoption; inspect the export.");
    }
    // Same-file release selection is UNCHANGED in the finalized RC contract.
    event.metadata = {
      ...metadata,
      update_strategy: null,
      rc_legacy_event: {
        type: event.type,
        from_bundle_id: event.from_bundle_id,
        update_strategy: metadata.update_strategy,
      },
    };
    event.type = "UNCHANGED";
    event.from_bundle_id = null;
  }
  return event;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , input, output] = process.argv;
  if (!input || !output)
    throw new Error(
      "Usage: node --experimental-strip-types scripts/insights-rc-export.ts input.ndjson output.ndjson",
    );
  // Never overwrite a backup. A failed conversion leaves an incomplete output
  // for inspection; discard it and retry with a new path before any replay.
  const writer = createWriteStream(output, { flags: "wx" });
  const finished = once(writer, "finish");
  await once(writer, "open");
  const lines = createInterface({
    input: createReadStream(input),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = normalizeInsightsRcEvent(JSON.parse(line));
    if (!writer.write(`${JSON.stringify(row)}\n`)) await once(writer, "drain");
  }
  writer.end();
  await finished;
}
