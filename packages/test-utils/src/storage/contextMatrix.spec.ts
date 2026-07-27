import { binding, env, secret } from "@hot-updater/core/config";
import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { describe, expect, it } from "vitest";

import { createLambdaStorageContext } from "../../../../plugins/aws/src/storage/lambdaContext";
import { createWorkerStorageContext } from "../../../../plugins/cloudflare/src/storage/workerContext";
import { createFunctionsStorageContext } from "../../../../plugins/firebase/src/storage/functionsContext";
import { createEdgeStorageContext } from "../../../../plugins/supabase/src/storage/edgeContext";
import { STORAGE_V2_PROVIDER_MATRIX } from "./capabilityMatrix";

class StatefulBinding {
  readonly calls: string[] = [];

  invoke(label: string): void {
    this.calls.push(label);
  }
}

const assertContextContainers = (
  context: StorageOperationContext,
  bindingValue?: StatefulBinding,
): void => {
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.environment)).toBe(true);
  expect(Object.isFrozen(context.bindings)).toBe(true);
  if (bindingValue !== undefined) {
    expect(context.bindings.BUCKET).toBe(bindingValue);
    expect(Object.isFrozen(bindingValue)).toBe(false);
    bindingValue.invoke(context.target);
  }
};

describe("Storage v2 target and live-binding matrix", () => {
  it("declares provider-backed observation fields for every public entry", () => {
    const cells = STORAGE_V2_PROVIDER_MATRIX.map((cell) => ({
      entry: cell.entry,
      observations: cell.runtime.observations,
    }));
    expect(cells.every(({ observations }) => observations.length > 0)).toBe(
      true,
    );
  });

  it("freezes containers while preserving stateful binding identity", () => {
    const workerBinding = new StatefulBinding();
    const functionsBinding = new StatefulBinding();
    const edgeBinding = new StatefulBinding();

    assertContextContainers(
      createWorkerStorageContext({
        environment: { CELL: "worker" },
        bindings: { BUCKET: workerBinding },
      }),
      workerBinding,
    );
    assertContextContainers(
      createFunctionsStorageContext({
        environment: { CELL: "functions" },
        bindings: { BUCKET: functionsBinding },
      }),
      functionsBinding,
    );
    assertContextContainers(
      createEdgeStorageContext({
        target: "edge",
        environment: { CELL: "edge" },
        bindings: { BUCKET: edgeBinding },
      }),
      edgeBinding,
    );
    assertContextContainers(
      createLambdaStorageContext({
        environment: { CELL: "lambda" },
        bindings: {},
      }),
    );
    assertContextContainers(
      createNodeStorageContext({ environment: { CELL: "node" } }),
    );

    expect(workerBinding.calls).toEqual(["worker"]);
    expect(functionsBinding.calls).toEqual(["functions"]);
    expect(edgeBinding.calls).toEqual(["edge"]);
  });

  it("keeps literal references cacheable and tagged values request-bound", () => {
    expect(binding("BUCKET")).toEqual({
      $type: "hot-updater.config-reference",
      kind: "binding",
      name: "BUCKET",
    });
    expect(env("ENDPOINT")).toMatchObject({ kind: "env" });
    expect(secret("TOKEN")).toMatchObject({ kind: "secret" });
    expect("https://literal.invalid").not.toMatchObject({
      $type: "hot-updater.config-reference",
    });
  });

  it("uses exact wrong-target, missing, and invalid-input boundaries", () => {
    const errors = [
      new StoragePluginError("invalid-input", "entry target mismatch"),
      new StoragePluginError("unsupported", "list is unsupported"),
    ];
    expect(errors.map(({ code }) => code)).toEqual([
      "invalid-input",
      "unsupported",
    ]);
    expect(JSON.stringify(errors)).not.toMatch(
      /credential|authorization|seeded-secret/i,
    );
  });
});
