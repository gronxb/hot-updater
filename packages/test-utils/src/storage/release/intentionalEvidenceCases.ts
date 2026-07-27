import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync } from "node:fs";
import path from "node:path";

import { it } from "vitest";

import {
  expectEvidenceFailure,
  type IntentionalEvidenceOptions,
  prepareFixture,
  receiptFor,
  receiptPathFor,
} from "./evidenceFailureHarness";
import { writeFixtureReceipt } from "./evidenceFixture";

export const registerIntentionalEvidenceCases = (
  options: IntentionalEvidenceOptions,
): void => {
  it("rejects malformed evidence schema", () => {
    const { fixture, root } = prepareFixture(options);
    writeFixtureReceipt(receiptPathFor(fixture, "1"), {
      ...receiptFor(fixture, "1"),
      schema: "broken",
    });

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "malformed-schema",
      "receipt-schema",
    );
  });

  it("rejects a non-ancestor historical SHA", () => {
    const { fixture, root } = prepareFixture(options);
    writeFixtureReceipt(receiptPathFor(fixture, "2"), {
      ...receiptFor(fixture, "2"),
      observedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "non-ancestor",
      "historical-crossed-epoch:2",
    );
  });

  it("rejects a wrong current final SHA", () => {
    const { fixture, root } = prepareFixture(options);
    writeFixtureReceipt(receiptPathFor(fixture, "24"), {
      ...receiptFor(fixture, "24"),
      observedSha: "0000000000000000000000000000000000000000",
    });

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "wrong-final-sha",
      "current-final-stale:24",
    );
  });

  it("rejects a duplicate run ordinal", () => {
    const { fixture, root } = prepareFixture(options);
    const duplicatePath = path.join(
      fixture.evidenceDirectory,
      "receipts/3/final/run-2/command-1.json",
    );
    writeFixtureReceipt(duplicatePath, receiptFor(fixture, "3"));

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "duplicate-run",
      "duplicate-run-ordinal:3:final:1",
    );
  });

  it("rejects a gapped run ordinal", () => {
    const { fixture, root } = prepareFixture(options);
    const run3 = path.join(
      fixture.evidenceDirectory,
      "receipts/3/final/run-3/command-1.json",
    );
    writeFixtureReceipt(run3, {
      ...receiptFor(fixture, "3"),
      runOrdinal: 3,
      artifacts: [],
    });

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "gapped-run",
      "gapped-run-ordinal:3:final",
    );
  });

  it("rejects a duplicate command ordinal", () => {
    const { fixture, root } = prepareFixture(options);
    copyFileSync(
      receiptPathFor(fixture, "4"),
      path.join(
        fixture.evidenceDirectory,
        "receipts/4/final/run-1/command-2.json",
      ),
    );

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "duplicate-command",
      "duplicate-command-ordinal:4:final:1:1",
    );
  });

  it("rejects a gapped command ordinal", () => {
    const { fixture, root } = prepareFixture(options);
    writeFixtureReceipt(receiptPathFor(fixture, "4"), {
      ...receiptFor(fixture, "4"),
      commandCount: 2,
    });
    writeFixtureReceipt(
      path.join(
        fixture.evidenceDirectory,
        "receipts/4/final/run-1/command-3.json",
      ),
      {
        ...receiptFor(fixture, "4"),
        commandOrdinal: 3,
        commandCount: 2,
      },
    );

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "gapped-command",
      "gapped-command-ordinal:4:final:1",
    );
  });

  it("rejects an incomplete current command set", () => {
    const { fixture, root } = prepareFixture(options);
    writeFixtureReceipt(
      path.join(
        fixture.evidenceDirectory,
        "receipts/5/final/run-2/command-1.json",
      ),
      {
        ...receiptFor(fixture, "5"),
        runOrdinal: 2,
        commandCount: 2,
        artifacts: [],
      },
    );

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "incomplete-current",
      "incomplete-command-set:5:final:2",
    );
  });

  it("rejects an overwritten historical artifact", () => {
    const { fixture, root } = prepareFixture(options);
    const artifactPath = fixture.artifactPaths.get("6");
    if (artifactPath === undefined) {
      throw new TypeError("Fixture artifact 6 is missing.");
    }
    appendFileSync(artifactPath, "overwritten\n");

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "overwritten-artifact",
      "artifact-hash:artifacts/6/final/run-1/output.txt",
    );
  });

  it("rejects a missing current supersession", () => {
    const { fixture, root } = prepareFixture(options);
    const ancestorSha = execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: options.workspace,
      encoding: "utf8",
    }).trim();
    writeFixtureReceipt(receiptPathFor(fixture, "24"), {
      ...receiptFor(fixture, "24"),
      observedSha: ancestorSha,
    });

    expectEvidenceFailure(
      options,
      fixture,
      root,
      "missing-current-supersession",
      "missing-current-supersession:24",
    );
  });
};
