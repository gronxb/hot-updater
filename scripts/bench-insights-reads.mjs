/**
 * Local workerd D1 read-cost comparison. No network or production database I/O.
 * Run: node scripts/bench-insights-reads.mjs > /tmp/insights-reads.json
 * Historical schemas are pinned so concurrent source edits cannot change inputs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireCloudflare = createRequire(
  resolve(root, "plugins/cloudflare/package.json"),
);
const requireWrangler = createRequire(
  requireCloudflare.resolve("wrangler/package.json"),
);
const { Miniflare } = requireWrangler("miniflare");
const baseline = "ef1a071e83fc870038a591b7b83d91a6a738f96c";
const eventOnly = "dfee6cb63e6cf6d79a03453284d2417f2c1600db";
const schemaPath =
  "plugins/cloudflare/worker/migrations/0001_hot-updater_1.0.0.sql";
const selectedSchema = readFileSync(resolve(root, schemaPath), "utf8");
const selectedSchemaSha256 = createHash("sha256")
  .update(selectedSchema)
  .digest("hex");
let selectedSchemaManifest;
const schemas = Object.fromEntries(
  [baseline, eventOnly].map((revision) => [
    revision,
    execFileSync("git", ["show", `${revision}:${schemaPath}`], {
      cwd: root,
      encoding: "utf8",
    }),
  ]),
);
const headFields = [
  "install_id",
  "id",
  "received_at_ms",
  "user_id",
  "platform",
  "channel",
  "type",
  "from_bundle_id",
  "to_bundle_id",
];
const bundleId = (value) =>
  `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const bundleIds = {
  common: bundleId(1),
  rare: bundleId(2),
  pending: bundleId(3),
};
const kinds = [
  "UNCHANGED",
  "UPDATE_DOWNLOADED",
  "UPDATE_DOWNLOADED",
  "UPDATE_APPLIED",
  "RECOVERED",
];
const quote = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
const values = (record) => `(${Object.values(record).map(quote).join(",")})`;
const insert = (table, records) =>
  `INSERT INTO ${table} (${Object.keys(records[0]).join(",")}) VALUES ${records.map(values).join(",")}`;
const pick = (record, fields) =>
  Object.fromEntries(fields.map((field) => [field, record[field]]));
const newer = (a, b) =>
  !b ||
  a.received_at_ms > b.received_at_ms ||
  (a.received_at_ms === b.received_at_ms && a.id > b.id);

function makeEvent(
  installation,
  sequence,
  scopedInstallations,
  bundleVariety = 1,
) {
  const type =
    kinds[
      (sequence + installation + Math.floor(installation / 10)) % kinds.length
    ];
  const running =
    installation % 1000 === 1
      ? bundleIds.rare
      : installation % bundleVariety === 0
        ? bundleIds.common
        : bundleId(100 + (installation % bundleVariety));
  return {
    id: `00000000-0000-7000-8000-${String(installation * 10000 + sequence).padStart(12, "0")}`,
    type,
    install_id: `install-${String(installation).padStart(6, "0")}`,
    user_id:
      installation % 11 === 0
        ? null
        : `user-${(installation + Math.floor(sequence / 4)) % 5}`,
    from_release_id: null,
    from_bundle_id: type === "UNCHANGED" ? null : running,
    to_release_id: null,
    to_bundle_id: type === "UPDATE_DOWNLOADED" ? bundleIds.pending : running,
    platform: installation < scopedInstallations ? "ios" : "android",
    app_version: "1.0.0",
    channel: sequence % 7 === 0 ? "preview" : "production",
    metadata: JSON.stringify({
      username: null,
      cohort: "0",
      update_strategy: type === "UNCHANGED" ? null : "appVersion",
      fingerprint_hash: null,
      sdk_version: "1.0.0-rc",
    }),
    received_at_ms: sequence * 10000 + installation,
  };
}
function oldEvent(event) {
  const { metadata, ...record } = event;
  return { ...record, ...JSON.parse(metadata) };
}
function snapshot(event) {
  return {
    ...pick(event, ["install_id", "id", "user_id"]),
    username: null,
    to_bundle_id:
      event.type === "UPDATE_DOWNLOADED"
        ? event.from_bundle_id
        : event.to_bundle_id,
    pending_bundle_id:
      event.type === "UPDATE_DOWNLOADED" ? event.to_bundle_id : null,
    pending_release_id: null,
    ...pick(event, ["type", "platform", "app_version", "channel"]),
    cohort: "0",
    received_at_ms: event.received_at_ms,
  };
}
const projectionSchema = `DROP INDEX bundle_events_user_idx;
CREATE TABLE bundle_event_heads (
 install_id TEXT PRIMARY KEY NOT NULL, id TEXT NOT NULL, received_at_ms REAL NOT NULL,
 user_id TEXT, platform TEXT NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL,
 from_bundle_id TEXT, to_bundle_id TEXT NOT NULL);
 CREATE INDEX bundle_event_heads_user_idx ON bundle_event_heads(user_id,install_id);
 CREATE INDEX bundle_event_heads_scope_idx ON bundle_event_heads(platform,channel,received_at_ms);`;
const strategies = [
  "snapshot",
  "event_only",
  "tuple_index",
  "pointer",
  "heads",
  "heads_bundle_indexes",
  "heads_bundle_union",
];
function additions(strategy) {
  if (strategy === "pointer")
    return "CREATE TABLE bundle_event_heads (install_id TEXT PRIMARY KEY NOT NULL, id TEXT NOT NULL);";
  if (strategy.startsWith("heads"))
    return (
      projectionSchema +
      (strategy === "heads_bundle_indexes" || strategy === "heads_bundle_union"
        ? `
 CREATE INDEX bundle_event_heads_from_idx ON bundle_event_heads(type,platform,channel,from_bundle_id,received_at_ms);
 CREATE INDEX bundle_event_heads_to_idx ON bundle_event_heads(type,platform,channel,to_bundle_id,received_at_ms);`
        : "")
    );
  if (strategy === "tuple_index")
    return "CREATE INDEX bundle_events_scope_idx ON bundle_events(platform,channel,received_at_ms);";
  return "";
}
function latestPredicate(strategy) {
  return `NOT EXISTS (SELECT 1 FROM bundle_events n WHERE n.install_id=e.install_id AND ${strategy === "tuple_index" ? "(n.received_at_ms,n.id)>(e.received_at_ms,e.id)" : "(n.received_at_ms>e.received_at_ms OR (n.received_at_ms=e.received_at_ms AND n.id>e.id))"})`;
}
function queries(strategy) {
  const direct = strategy === "snapshot" || strategy.startsWith("heads");
  const table =
    strategy === "snapshot"
      ? "bundle_installations"
      : direct || strategy === "pointer"
        ? "bundle_event_heads"
        : "bundle_events";
  const alias = direct ? "h" : "e";
  const installAlias = strategy === "pointer" ? "h" : alias;
  const isEventOnly = strategy === "event_only" || strategy === "tuple_index";
  const latest = isEventOnly ? `${latestPredicate(strategy)} AND ` : "";
  const countFrom =
    strategy === "pointer"
      ? "bundle_event_heads h JOIN bundle_events e ON e.id=h.id"
      : `${table} ${alias}`;
  const page = (where, limit) => {
    if (strategy.startsWith("heads"))
      return `SELECT e.* FROM (SELECT id,install_id FROM bundle_event_heads h WHERE ${where} ORDER BY install_id LIMIT ${limit}) h JOIN bundle_events e ON e.id=h.id ORDER BY h.install_id`;
    return `SELECT ${alias}.* FROM ${countFrom} WHERE ${latest}${where} ORDER BY ${installAlias}.install_id LIMIT ${limit}`;
  };
  const scope = `${alias}.platform='ios' AND ${alias}.channel='production' AND ${alias}.received_at_ms>=0`;
  const count = (where) =>
    `SELECT COUNT(*) AS count FROM ${countFrom} WHERE ${latest}(${where})`;
  const bundle = (name) =>
    strategy === "snapshot"
      ? `${scope} AND h.to_bundle_id=${quote(name)}`
      : `(${scope} AND ${alias}.type='UPDATE_DOWNLOADED' AND ${alias}.from_bundle_id=${quote(name)}) OR (${scope} AND ${alias}.type IN ('UNCHANGED','UPDATE_APPLIED','RECOVERED') AND ${alias}.to_bundle_id=${quote(name)})`;
  const bundleCount = (name) =>
    strategy === "heads_bundle_union"
      ? `SELECT COUNT(*) AS count FROM (SELECT h.install_id FROM bundle_event_heads h WHERE ${scope} AND h.type='UPDATE_DOWNLOADED' AND h.from_bundle_id=${quote(name)} UNION SELECT h.install_id FROM bundle_event_heads h WHERE ${scope} AND h.type IN ('UNCHANGED','UPDATE_APPLIED','RECOVERED') AND h.to_bundle_id=${quote(name)})`
      : count(bundle(name));
  return {
    exact: page(`${installAlias}.install_id='install-000500'`, 1),
    user_first: page(`${alias}.user_id='user-1'`, 101),
    user_later: page(
      `${alias}.user_id='user-1' AND ${alias}.install_id>'install-000500'`,
      101,
    ),
    scope_count: count(scope),
    common_bundle_count: bundleCount(bundleIds.common),
    rare_bundle_count: bundleCount(bundleIds.rare),
  };
}
function expectedAnswers(heads) {
  const sorted = [...heads.values()].sort((a, b) =>
    a.install_id.localeCompare(b.install_id),
  );
  const scoped = sorted.filter(
    (event) => event.platform === "ios" && event.channel === "production",
  );
  const users = sorted.filter((event) => event.user_id === "user-1");
  const running = (event) =>
    event.type === "UPDATE_DOWNLOADED"
      ? event.from_bundle_id
      : event.to_bundle_id;
  return {
    exact: [heads.get("install-000500").id],
    user_first: users.slice(0, 101).map((event) => event.id),
    user_later: users
      .filter((event) => event.install_id > "install-000500")
      .slice(0, 101)
      .map((event) => event.id),
    scope_count: scoped.length,
    common_bundle_count: scoped.filter(
      (event) => running(event) === bundleIds.common,
    ).length,
    rare_bundle_count: scoped.filter(
      (event) => running(event) === bundleIds.rare,
    ).length,
  };
}
function writeReceipt(strategy, event) {
  const canonical = strategy === "snapshot" ? oldEvent(event) : event;
  const statements = [
    `${insert("bundle_events", [canonical])} ON CONFLICT(id) DO NOTHING`,
  ];
  if (strategy === "event_only" || strategy === "tuple_index")
    return statements;
  const record =
    strategy === "snapshot"
      ? snapshot(event)
      : pick(event, strategy === "pointer" ? ["install_id", "id"] : headFields);
  const table =
    strategy === "snapshot" ? "bundle_installations" : "bundle_event_heads";
  const fields = Object.keys(record);
  const updates = fields
    .filter((field) => field !== "install_id")
    .map((field) => `${field}=excluded.${field}`)
    .join(",");
  // Select the stored canonical event after duplicate-ID insertion, as providers do.
  let selection = fields.join(",");
  if (strategy === "snapshot")
    selection = fields
      .map((field) =>
        field === "to_bundle_id"
          ? "CASE WHEN type='UPDATE_DOWNLOADED' THEN from_bundle_id ELSE to_bundle_id END"
          : field === "pending_bundle_id"
            ? "CASE WHEN type='UPDATE_DOWNLOADED' THEN to_bundle_id ELSE NULL END"
            : field === "pending_release_id"
              ? "NULL"
              : field,
      )
      .join(",");
  const guard =
    strategy === "pointer"
      ? `(SELECT received_at_ms FROM bundle_events WHERE id=excluded.id)>(SELECT received_at_ms FROM bundle_events WHERE id=${table}.id) OR ((SELECT received_at_ms FROM bundle_events WHERE id=excluded.id)=(SELECT received_at_ms FROM bundle_events WHERE id=${table}.id) AND excluded.id>${table}.id)`
      : `(excluded.received_at_ms,excluded.id)>(${table}.received_at_ms,${table}.id)`;
  statements.push(
    `INSERT INTO ${table} (${fields.join(",")}) SELECT ${selection} FROM bundle_events WHERE id=${quote(event.id)} ON CONFLICT(install_id) DO UPDATE SET ${updates} WHERE ${guard}`,
  );
  return statements;
}
function bindQuery(db, query) {
  const parameters = [];
  const sql = query.replace(
    /'(?:''|[^'])*'|(?<=(?:>=|LIMIT ))\d+/g,
    (value) => {
      parameters.push(
        JSON.stringify(
          value.startsWith("'")
            ? value.slice(1, -1).replaceAll("''", "'")
            : Number(value),
        ),
      );
      return "json_extract(?, '$')";
    },
  );
  return { sql, parameters, statement: db.prepare(sql).bind(...parameters) };
}
async function measure(db, query, expected) {
  const bound = bindQuery(db, query);
  const plan = (
    await db
      .prepare(`EXPLAIN QUERY PLAN ${bound.sql}`)
      .bind(...bound.parameters)
      .all()
  ).results.map((row) => row.detail);
  const started = performance.now();
  let timeout;
  const result = await Promise.race([
    bound.statement.all(),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Query exceeded 30 seconds")),
        30000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  const elapsed = performance.now() - started;
  const answer =
    typeof expected === "number"
      ? result.results[0].count
      : result.results.map((row) => row.id);
  assert.deepEqual(answer, expected);
  return {
    rows_read: result.meta.rows_read,
    rows_written: result.meta.rows_written,
    elapsed_ms: Number(elapsed.toFixed(3)),
    result_count: typeof answer === "number" ? answer : answer.length,
    plan,
    sql: bound.sql,
    parameters: bound.parameters,
  };
}
const results = [];
// The final case adds unrelated installations without changing the target scope.
const datasets = [
  { scoped: 1000, unrelated: 0, depth: 10, bundleVariety: 1 },
  { scoped: 1000, unrelated: 0, depth: 100, bundleVariety: 1 },
  { scoped: 1000, unrelated: 9000, depth: 10, bundleVariety: 1 },
  { scoped: 1000, unrelated: 0, depth: 100, bundleVariety: 10 },
];
for (const dataset of datasets) {
  const events = [];
  const heads = new Map();
  for (let i = 0; i < dataset.scoped + dataset.unrelated; i++) {
    for (let sequence = 0; sequence < dataset.depth; sequence++) {
      const event = makeEvent(
        i,
        sequence,
        dataset.scoped,
        dataset.bundleVariety,
      );
      events.push(event);
      if (newer(event, heads.get(event.install_id)))
        heads.set(event.install_id, event);
    }
  }
  const expected = expectedAnswers(heads);
  const measurement = { ...dataset, events: events.length, strategies: {} };
  for (const strategy of strategies) {
    process.stderr.write(`${JSON.stringify(dataset)} ${strategy}\n`);
    const mf = new Miniflare({
      host: "127.0.0.1",
      modules: true,
      script:
        'export default {fetch() {return new Response("local benchmark")}}',
      compatibilityDate: "2026-06-01",
      d1Databases: { DB: "insights-read-benchmark" },
    });
    try {
      const db = await mf.getD1Database("DB");
      // exec splits on newlines; prepare each complete schema statement instead.
      const schema =
        strategy === "heads_bundle_indexes"
          ? selectedSchema
          : schemas[strategy === "snapshot" ? baseline : eventOnly] +
            additions(strategy);
      for (const statement of schema
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
      if (strategy === "heads_bundle_indexes") {
        const manifest = {};
        for (const table of ["bundle_events", "bundle_event_heads"]) {
          const columns = (
            await db.prepare(`PRAGMA table_info(${table})`).all()
          ).results;
          const indexes = (
            await db.prepare(`PRAGMA index_list(${table})`).all()
          ).results;
          const definitions = [];
          for (const index of indexes)
            definitions.push({
              name: index.name,
              unique: index.unique,
              columns: (
                await db.prepare(`PRAGMA index_info(${index.name})`).all()
              ).results.map((column) => column.name),
            });
          manifest[table] = {
            columns,
            indexes: definitions.sort((a, b) => a.name.localeCompare(b.name)),
          };
        }
        assert.deepEqual(
          manifest.bundle_event_heads.columns.map((column) => column.name),
          headFields,
        );
        assert.equal(
          manifest.bundle_events.indexes.some(
            (index) => index.name === "bundle_events_user_idx",
          ),
          false,
        );
        for (const side of ["from", "to"])
          assert.deepEqual(
            manifest.bundle_event_heads.indexes.find(
              (index) => index.name === `bundle_event_heads_${side}_idx`,
            ).columns,
            [
              "type",
              "platform",
              "channel",
              `${side}_bundle_id`,
              "received_at_ms",
            ],
          );
        if (selectedSchemaManifest)
          assert.deepEqual(manifest, selectedSchemaManifest);
        selectedSchemaManifest = manifest;
      }
      let loadRowsWritten = 0;
      for (let offset = 0; offset < events.length; offset += 5000) {
        const statements = [];
        for (
          let batch = offset;
          batch < Math.min(offset + 5000, events.length);
          batch += 100
        ) {
          const records = events
            .slice(batch, batch + 100)
            .map((event) =>
              strategy === "snapshot" ? oldEvent(event) : event,
            );
          statements.push(db.prepare(insert("bundle_events", records)));
        }
        for (const result of await db.batch(statements))
          loadRowsWritten += result.meta.rows_written;
      }
      if (
        strategy === "snapshot" ||
        strategy === "pointer" ||
        strategy.startsWith("heads")
      ) {
        const records = [...heads.values()].map((event) =>
          strategy === "snapshot"
            ? snapshot(event)
            : pick(
                event,
                strategy === "pointer" ? ["install_id", "id"] : headFields,
              ),
        );
        for (let offset = 0; offset < records.length; offset += 100)
          loadRowsWritten += (
            await db
              .prepare(
                insert(
                  strategy === "snapshot"
                    ? "bundle_installations"
                    : "bundle_event_heads",
                  records.slice(offset, offset + 100),
                ),
              )
              .run()
          ).meta.rows_written;
      }
      await db.prepare("ANALYZE").run();
      const measurements = {};
      for (const [name, query] of Object.entries(queries(strategy)))
        measurements[name] = await measure(db, query, expected[name]);
      const databaseBytes = (
        await db.prepare("SELECT COUNT(*) FROM bundle_events").all()
      ).meta.size_after;
      const writes = {};
      const advanced = makeEvent(
        500,
        dataset.depth + 1,
        dataset.scoped,
        dataset.bundleVariety,
      );
      const delayed = {
        ...makeEvent(500, 0, dataset.scoped, dataset.bundleVariety),
        id: "00000000-0000-7000-8000-999999999999",
      };
      for (const [name, receipt] of [
        ["new_event_existing_installation", advanced],
        ["duplicate_event", advanced],
        ["delayed_event", delayed],
      ]) {
        const receipts = await db.batch(
          writeReceipt(strategy, receipt).map((query) => db.prepare(query)),
        );
        writes[name] = {
          rows_read: receipts.reduce(
            (sum, result) => sum + result.meta.rows_read,
            0,
          ),
          rows_written: receipts.reduce(
            (sum, result) => sum + result.meta.rows_written,
            0,
          ),
        };
      }
      assert.equal(
        (await db.prepare(queries(strategy).exact).all()).results[0].id,
        advanced.id,
      );
      measurement.strategies[strategy] = {
        database_bytes: databaseBytes,
        fixture_load_rows_written: loadRowsWritten,
        writes,
        queries: measurements,
      };
      process.stderr.write(
        `  scope=${measurements.scope_count.rows_read} user=${measurements.user_first.rows_read} rare=${measurements.rare_bundle_count.rows_read}\n`,
      );
    } finally {
      await mf.dispose();
    }
  }
  results.push(measurement);
}
for (const dataset of results) {
  const first = results[0].strategies.heads_bundle_indexes.queries;
  const selected = dataset.strategies.heads_bundle_indexes.queries;
  for (const query of [
    "exact",
    "user_first",
    "scope_count",
    "rare_bundle_count",
  ])
    assert.equal(selected[query].rows_read, first[query].rows_read);
  if (dataset.bundleVariety === 1)
    assert.equal(
      selected.common_bundle_count.rows_read,
      first.common_bundle_count.rows_read,
    );
}
console.log(
  JSON.stringify(
    {
      baseline,
      event_only: eventOnly,
      selected_strategy: "heads_bundle_indexes",
      selected_schema: {
        path: schemaPath,
        sha256: selectedSchemaSha256,
        manifest: selectedSchemaManifest,
      },
      miniflare: requireWrangler("miniflare/package.json").version,
      node: process.version,
      notes: [
        "Local workerd D1 meta.rows_read/rows_written, not production billing or the causal multiplier of the quota incident.",
        "Same canonical events and expected latest IDs/counts across all strategies. Runtime-shaped OR groups and json_extract parameter binding. One measured read per query after ANALYZE; elapsed time includes local proxy overhead and is secondary to row counts.",
        "Fixtures bulk-load history then insert only final heads. fixture_load_rows_written is construction cost, not realistic ingestion cost; writes reports separate atomic per-event receipt costs including duplicate/delayed delivery.",
        "database_bytes is D1 meta.size_after after fixture construction; not retained production storage or network transfer.",
        "Current-user and scope filters apply after choosing the global latest event. Fixtures include user/channel moves, anonymous users, and all event kinds. Latest type varies independently within each common bundle. The rare running bundle belongs to one in 1000 installations. bundleVariety controls the number of other current bundles. Every event and bundle identifier uses a valid 36-character UUIDv7 representation.",
        "Historical snapshot pages return their stored installation payload; all other strategies return full canonical event payload. ID results are identical; heads hydrate canonical rows after paging, accounting for 101 extra reads for a 101-row page.",
        "Head projections remove the obsolete canonical-event user index. The selected strategy uses the captured current migration verbatim, records its SHA-256 and PRAGMA column/index manifest, and verifies the nine-field head and bundle index definitions. Historical and tuple/pointer alternatives retain their pinned event indexes.",
      ],
      results,
    },
    null,
    2,
  ),
);
