import crypto from "node:crypto";

import type {
  GenerationEvent,
  GenerationEventsSnapshot,
} from "../../examples/lynx/src/e2eApp/generationEvents.ts";
import { compareGenerationEventSequence } from "../../examples/lynx/src/e2eApp/generationEvents.ts";

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("event is not valid JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};

const digest = (value: unknown) =>
  crypto.createHash("sha256").update(canonical(value)).digest("hex");

export type GenerationEventLedgerReceipt = {
  readonly schemaVersion: "lynx-generation-event-ledger-v1";
  readonly oldestSequence: string | null;
  readonly latestSequence: string | null;
  readonly eventCount: number;
  readonly sha256: string;
  readonly checkpoints: readonly {
    readonly stage: string;
    readonly oldestSequence: string | null;
    readonly latestSequence: string | null;
    readonly truncated: boolean;
    readonly snapshotSha256: string;
    readonly ledgerSha256: string;
  }[];
};

export class GenerationEventLedger {
  private readonly events = new Map<string, GenerationEvent>();
  private readonly encodedEvents = new Map<string, string>();
  private readonly checkpoints: GenerationEventLedgerReceipt["checkpoints"][number][] =
    [];

  merge(stage: string, snapshot: GenerationEventsSnapshot): void {
    const priorLatest = this.latestSequence();
    if (snapshot.truncated) {
      if (priorLatest === null || snapshot.oldestSequence === null) {
        throw new Error(
          `${stage}: truncated native evidence has no external ledger bridge`,
        );
      }
      const maximumNext = BigInt(priorLatest) + 1n;
      if (BigInt(snapshot.oldestSequence) > maximumNext) {
        throw new Error(
          `${stage}: truncated native evidence hid a sequence gap`,
        );
      }
    } else if (snapshot.events.length > 0 && snapshot.oldestSequence !== "1") {
      throw new Error(`${stage}: untruncated native evidence must begin at 1`);
    }

    for (const event of snapshot.events) {
      const encoded = canonical(event);
      const prior = this.encodedEvents.get(event.sequence);
      if (prior !== undefined && prior !== encoded) {
        throw new Error(
          `${stage}: overlapping native event ${event.sequence} changed bytes`,
        );
      }
      this.events.set(event.sequence, event);
      this.encodedEvents.set(event.sequence, encoded);
    }

    const latest = snapshot.latestSequence;
    if (latest !== null) {
      for (let current = 1n; current <= BigInt(latest); current += 1n) {
        if (!this.events.has(String(current))) {
          throw new Error(
            `${stage}: external native event ledger is not contiguous`,
          );
        }
      }
    }
    const receipt = this.receipt();
    this.checkpoints.push({
      stage,
      oldestSequence: snapshot.oldestSequence,
      latestSequence: snapshot.latestSequence,
      truncated: snapshot.truncated,
      snapshotSha256: digest(snapshot),
      ledgerSha256: receipt.sha256,
    });
  }

  receipt(): GenerationEventLedgerReceipt {
    const events = [...this.events.values()].sort((left, right) =>
      compareGenerationEventSequence(left.sequence, right.sequence),
    );
    return {
      schemaVersion: "lynx-generation-event-ledger-v1",
      oldestSequence: events[0]?.sequence ?? null,
      latestSequence: events.at(-1)?.sequence ?? null,
      eventCount: events.length,
      sha256: digest(events),
      checkpoints: [...this.checkpoints],
    };
  }

  private latestSequence(): string | null {
    let latest: string | null = null;
    for (const sequence of this.events.keys()) {
      if (
        latest === null ||
        compareGenerationEventSequence(sequence, latest) > 0
      ) {
        latest = sequence;
      }
    }
    return latest;
  }
}
