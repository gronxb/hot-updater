import type { MongoAnalyticsDocument } from "./mongodbTypes";

export const MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR = {
  $jsonSchema: {
    additionalProperties: false,
    bsonType: "object",
    oneOf: [
      {
        properties: {
          from_bundle_id: { bsonType: "string" },
          type: { enum: ["UPDATE_APPLIED", "RECOVERED"] },
          update_strategy: { enum: ["fingerprint", "appVersion"] },
        },
      },
      {
        properties: {
          from_bundle_id: { bsonType: "null" },
          type: { enum: ["UNCHANGED"] },
          update_strategy: { bsonType: "null" },
        },
      },
    ],
    properties: {
      _id: {},
      app_version: { bsonType: "string" },
      channel: { bsonType: "string" },
      cohort: { bsonType: "string" },
      fingerprint_hash: { bsonType: ["string", "null"] },
      from_bundle_id: { bsonType: ["string", "null"] },
      id: { bsonType: "string" },
      install_id: { bsonType: "string" },
      platform: { enum: ["android", "ios"] },
      received_at_ms: { bsonType: "number" },
      sdk_version: { bsonType: ["string", "null"] },
      to_bundle_id: { bsonType: "string" },
      type: { bsonType: "string" },
      update_strategy: { bsonType: ["string", "null"] },
      user_id: { bsonType: ["string", "null"] },
      username: { bsonType: ["string", "null"] },
    },
    required: [
      "id",
      "type",
      "install_id",
      "user_id",
      "username",
      "from_bundle_id",
      "to_bundle_id",
      "platform",
      "app_version",
      "channel",
      "cohort",
      "update_strategy",
      "fingerprint_hash",
      "sdk_version",
      "received_at_ms",
    ],
  },
} as const satisfies MongoAnalyticsDocument;

type MongoAnalyticsIndex = {
  readonly key: Readonly<Record<string, 1>>;
  readonly name: string;
  readonly unique?: true;
};

export const mongoAnalyticsIndexes: readonly MongoAnalyticsIndex[] = [
  { name: "bundle_events_id_idx", key: { id: 1 }, unique: true },
  {
    name: "bundle_events_installed_bundle_idx",
    key: { type: 1, to_bundle_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_recovered_bundle_idx",
    key: { type: 1, from_bundle_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_install_idx",
    key: { install_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_user_id_idx",
    key: { user_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_username_idx",
    key: { username: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_cohort_idx",
    key: { cohort: 1, type: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_received_at_idx",
    key: { received_at_ms: 1, id: 1 },
  },
];
