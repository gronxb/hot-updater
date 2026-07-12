import {
  addSetValueV2,
  createSetV2,
  hasSetValueV2,
} from "./collectionIntrinsics";
import type { DatabaseManifestTupleV2 } from "./manifest";
import {
  ADAPTER_FAMILIES,
  CERTIFICATION_TIERS,
  CLIENT_OWNERSHIP,
  COMMIT_GUARANTEES,
  COMMIT_PRIMITIVES,
  CURSOR_CAPABILITIES,
  EVENT_CAPABILITIES,
  MANAGEMENT_CAPABILITIES,
  RUNTIME_FAMILIES,
  SUPPORT_TIERS,
  TARGET_PRODUCTS,
} from "./manifestGrammar";
import {
  failManifest,
  parseExactRecord,
  parseLiteral,
  parseNonEmptyString,
} from "./manifestValidationPrimitives";

const parseNamedVersion = (value: unknown, label: string) => {
  const record = parseExactRecord(value, ["name", "version"], label);
  return {
    name: parseNonEmptyString(record["name"], `${label}.name`),
    version: parseNonEmptyString(record["version"], `${label}.version`),
  };
};

const parseConstraints = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) {
    return failManifest("runtime.constraints");
  }
  const constraints: string[] = [];
  const seen = createSetV2<string>();
  for (const candidate of value) {
    const constraint = parseNonEmptyString(
      candidate,
      "runtime.constraints item",
    );
    if (hasSetValueV2(seen, constraint)) {
      return failManifest("runtime.constraints duplicates");
    }
    addSetValueV2(seen, constraint);
    constraints.push(constraint);
  }
  constraints.sort();
  return constraints;
};

export const parseDatabaseManifestTupleV2 = (
  value: unknown,
): DatabaseManifestTupleV2 => {
  const root = parseExactRecord(
    value,
    [
      "kind",
      "apiVersion",
      "supportTier",
      "connector",
      "adapter",
      "driver",
      "target",
      "runtime",
      "certification",
      "schema",
      "capabilities",
      "lifecycle",
    ],
    "tuple",
  );
  if (
    root["kind"] !== "hot-updater.database-connector" ||
    root["apiVersion"] !== 2
  ) {
    return failManifest("identity");
  }
  const adapter = parseExactRecord(
    root["adapter"],
    ["family", "version"],
    "adapter",
  );
  const target = parseExactRecord(
    root["target"],
    ["product", "transport"],
    "target",
  );
  const runtime = parseExactRecord(
    root["runtime"],
    ["family", "version", "constraints"],
    "runtime",
  );
  const certification = parseExactRecord(
    root["certification"],
    ["tier", "id"],
    "certification",
  );
  const schema = parseExactRecord(
    root["schema"],
    ["readable", "writable"],
    "schema",
  );
  const capabilities = parseExactRecord(
    root["capabilities"],
    ["commit", "cursor", "events", "management"],
    "capabilities",
  );
  const commit = parseExactRecord(
    capabilities["commit"],
    ["guarantee", "primitive", "interactiveTransaction"],
    "capabilities.commit",
  );
  const lifecycle = parseExactRecord(
    root["lifecycle"],
    ["clientOwnership"],
    "lifecycle",
  );
  if (typeof commit["interactiveTransaction"] !== "boolean") {
    return failManifest("capabilities.commit.interactiveTransaction");
  }
  return {
    kind: "hot-updater.database-connector",
    apiVersion: 2,
    supportTier: parseLiteral(
      root["supportTier"],
      SUPPORT_TIERS,
      "supportTier",
    ),
    connector: parseNamedVersion(root["connector"], "connector"),
    adapter: {
      family: parseLiteral(
        adapter["family"],
        ADAPTER_FAMILIES,
        "adapter.family",
      ),
      version: parseNonEmptyString(adapter["version"], "adapter.version"),
    },
    driver: parseNamedVersion(root["driver"], "driver"),
    target: {
      product: parseLiteral(
        target["product"],
        TARGET_PRODUCTS,
        "target.product",
      ),
      transport: parseNonEmptyString(target["transport"], "target.transport"),
    },
    runtime: {
      family: parseLiteral(
        runtime["family"],
        RUNTIME_FAMILIES,
        "runtime.family",
      ),
      version: parseNonEmptyString(runtime["version"], "runtime.version"),
      constraints: parseConstraints(runtime["constraints"]),
    },
    certification: {
      tier: parseLiteral(
        certification["tier"],
        CERTIFICATION_TIERS,
        "certification.tier",
      ),
      id: parseNonEmptyString(certification["id"], "certification.id"),
    },
    schema: {
      readable: parseNonEmptyString(schema["readable"], "schema.readable"),
      writable: parseNonEmptyString(schema["writable"], "schema.writable"),
    },
    capabilities: {
      commit: {
        guarantee: parseLiteral(
          commit["guarantee"],
          COMMIT_GUARANTEES,
          "capabilities.commit.guarantee",
        ),
        primitive: parseLiteral(
          commit["primitive"],
          COMMIT_PRIMITIVES,
          "capabilities.commit.primitive",
        ),
        interactiveTransaction: commit["interactiveTransaction"],
      },
      cursor: parseLiteral(
        capabilities["cursor"],
        CURSOR_CAPABILITIES,
        "capabilities.cursor",
      ),
      events: parseLiteral(
        capabilities["events"],
        EVENT_CAPABILITIES,
        "capabilities.events",
      ),
      management: parseLiteral(
        capabilities["management"],
        MANAGEMENT_CAPABILITIES,
        "capabilities.management",
      ),
    },
    lifecycle: {
      clientOwnership: parseLiteral(
        lifecycle["clientOwnership"],
        CLIENT_OWNERSHIP,
        "lifecycle.clientOwnership",
      ),
    },
  };
};
