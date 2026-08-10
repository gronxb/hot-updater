import { defineUniversalComponentSchema } from "@hot-updater/plugin-core";

const indexes = [
  {
    columns: ["type", "to_bundle_id", "received_at_ms", "id"],
    name: "bundle_events_installed_bundle_idx",
  },
  {
    columns: ["type", "from_bundle_id", "received_at_ms", "id"],
    name: "bundle_events_recovered_bundle_idx",
  },
  {
    columns: ["install_id", "received_at_ms", "id"],
    name: "bundle_events_install_idx",
  },
  {
    columns: ["user_id", "received_at_ms", "id"],
    name: "bundle_events_user_id_idx",
  },
  {
    columns: ["username", "received_at_ms", "id"],
    name: "bundle_events_username_idx",
  },
  {
    columns: ["cohort", "type", "received_at_ms", "id"],
    name: "bundle_events_cohort_idx",
  },
  {
    columns: ["received_at_ms", "id"],
    name: "bundle_events_received_at_idx",
  },
] as const;

const validationChecks = [
  {
    enforcement: "validation",
    expression: {
      expressions: [
        { column: "install_id", op: "non-empty" },
        { column: "app_version", op: "non-empty" },
        { column: "channel", op: "non-empty" },
        { column: "cohort", op: "non-empty" },
      ],
      op: "all",
    },
    name: "bundle_events_required_text_validation",
  },
  {
    enforcement: "validation",
    expression: {
      expressions: [
        {
          expressions: [
            { column: "user_id", op: "is-null" },
            { column: "user_id", op: "non-empty" },
          ],
          op: "any",
        },
        {
          expressions: [
            { column: "username", op: "is-null" },
            { column: "username", op: "non-empty" },
          ],
          op: "any",
        },
        {
          expressions: [
            { column: "fingerprint_hash", op: "is-null" },
            { column: "fingerprint_hash", op: "non-empty" },
          ],
          op: "any",
        },
        {
          expressions: [
            { column: "sdk_version", op: "is-null" },
            { column: "sdk_version", op: "non-empty" },
          ],
          op: "any",
        },
      ],
      op: "all",
    },
    name: "bundle_events_nullable_text_validation",
  },
  {
    enforcement: "validation",
    expression: {
      column: "platform",
      op: "in",
      values: ["android", "ios"],
    },
    name: "bundle_events_platform_validation",
  },
  {
    enforcement: "validation",
    expression: {
      expressions: [
        { column: "received_at_ms", op: "integer" },
        { column: "received_at_ms", op: "gte", value: 0 },
        {
          column: "received_at_ms",
          op: "lte",
          value: Number.MAX_SAFE_INTEGER,
        },
      ],
      op: "all",
    },
    name: "bundle_events_received_at_validation",
  },
] as const;

const orderedScans = [
  {
    columns: ["received_at_ms", "id"],
    name: "bundle_events_by_received_at",
    table: "bundle_events",
  },
] as const;

export const analyticsComponentSchema = defineUniversalComponentSchema({
  id: "analytics",
  unmarked: {
    adopt: [
      { version: "1", when: ["0.37.0"] },
      {
        version: "2",
        when: [
          null,
          "0.21.0",
          "0.29.0",
          "0.31.0",
          "0.36.0",
          "0.37.0",
          "0.38.0",
        ],
      },
    ],
    createWhen: [null, "0.21.0", "0.29.0", "0.31.0", "0.36.0"],
    discriminatorKey: "version",
    knownValues: [
      null,
      "0.21.0",
      "0.29.0",
      "0.31.0",
      "0.36.0",
      "0.37.0",
      "0.38.0",
    ],
  },
  versions: [
    {
      orderedScans,
      tables: [
        {
          checks: [
            {
              expression: {
                column: "type",
                op: "in",
                values: ["UPDATE_APPLIED", "RECOVERED"],
              },
              name: "bundle_events_type_check",
            },
            {
              expression: {
                column: "update_strategy",
                op: "in",
                values: ["fingerprint", "appVersion"],
              },
              name: "bundle_events_update_strategy_check",
            },
            ...validationChecks,
          ],
          columns: [
            { name: "id", primaryKey: true, type: "uuid" },
            { name: "type", type: "string" },
            { name: "install_id", type: "string" },
            { name: "user_id", nullable: true, type: "string" },
            { name: "username", nullable: true, type: "string" },
            { name: "from_bundle_id", type: "uuid" },
            { name: "to_bundle_id", type: "uuid" },
            { name: "platform", type: "string" },
            { name: "app_version", type: "string" },
            { name: "channel", type: "string" },
            { name: "cohort", type: "string" },
            { name: "update_strategy", type: "string" },
            { name: "fingerprint_hash", nullable: true, type: "string" },
            { name: "sdk_version", nullable: true, type: "string" },
            { name: "received_at_ms", type: "float" },
          ],
          indexes,
          name: "bundle_events",
        },
      ],
      version: "1",
    },
    {
      orderedScans,
      tables: [
        {
          checks: [
            {
              expression: {
                column: "type",
                op: "in",
                values: ["UPDATE_APPLIED", "RECOVERED", "UNCHANGED"],
              },
              name: "bundle_events_type_v038_check",
            },
            {
              expression: {
                expressions: [
                  { column: "update_strategy", op: "is-null" },
                  {
                    column: "update_strategy",
                    op: "in",
                    values: ["fingerprint", "appVersion"],
                  },
                ],
                op: "any",
              },
              name: "bundle_events_update_strategy_v038_check",
            },
            {
              expression: {
                expressions: [
                  {
                    expressions: [
                      {
                        column: "type",
                        op: "in",
                        values: ["UPDATE_APPLIED", "RECOVERED"],
                      },
                      { column: "from_bundle_id", op: "is-not-null" },
                      { column: "update_strategy", op: "is-not-null" },
                    ],
                    op: "all",
                  },
                  {
                    expressions: [
                      { column: "type", op: "eq", value: "UNCHANGED" },
                      { column: "from_bundle_id", op: "is-null" },
                      { column: "update_strategy", op: "is-null" },
                    ],
                    op: "all",
                  },
                ],
                op: "any",
              },
              name: "bundle_events_shape_v038_check",
            },
            ...validationChecks,
          ],
          columns: [
            { name: "id", primaryKey: true, type: "uuid" },
            { name: "type", type: "string" },
            { name: "install_id", type: "string" },
            { name: "user_id", nullable: true, type: "string" },
            { name: "username", nullable: true, type: "string" },
            { name: "from_bundle_id", nullable: true, type: "uuid" },
            { name: "to_bundle_id", type: "uuid" },
            { name: "platform", type: "string" },
            { name: "app_version", type: "string" },
            { name: "channel", type: "string" },
            { name: "cohort", type: "string" },
            { name: "update_strategy", nullable: true, type: "string" },
            { name: "fingerprint_hash", nullable: true, type: "string" },
            { name: "sdk_version", nullable: true, type: "string" },
            { name: "received_at_ms", type: "float" },
          ],
          indexes,
          name: "bundle_events",
        },
      ],
      version: "2",
    },
  ],
});
