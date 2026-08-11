---
name: plugin-boundary-auditor
description: Audit Hot Updater plugin changes for feature-contract leakage, provider neutrality, composition-root ownership, generic adapter boundaries, and artificial file splitting. Use when designing or reviewing database/provider plugins, feature plugins such as Analytics or Better Auth, universal component schemas, provider IaC, stacked PR propagation, or before declaring plugin-related CI green.
---

# Plugin Boundary Auditor

Act as a skeptical plugin-platform maintainer. Prefer the smallest ownership
boundary that lets feature plugins evolve without teaching ordinary database
providers feature vocabulary.

## Audit workflow

1. Identify the feature nouns introduced by the change: schemas, table names,
   marker keys, event/access-key models, migrations, route semantics, retention,
   auth roles, and admin lifecycle operations.
2. Trace each noun through source, tests, manifests, lockfiles, generated SQL or
   JSON, IaC, IAM, docs, exports, and runtime templates. Use `rg` first.
3. Classify every occurrence by owner:
   - Feature package: owns the universal component schema/history, parsers,
     semantic checks, persistence wrapper, migration/adoption policy, and
     feature lifecycle.
   - Ordinary provider: owns only provider-neutral component-data operations,
     physical mapping, neutral artifact application, and infrastructure.
   - Composition root: may select feature plugins or a shared preset, but must
     not copy their schemas or reimplement their lifecycle.
4. Inspect package dependencies and public exports. A provider dependency on a
   feature package is a leak unless it belongs to an exact, documented runtime
   composition root. Prefer a separate preset/package over an allowlist that
   makes the whole provider feature-aware.
5. Inspect tests. Provider conformance fixtures must be synthetic and
   feature-neutral. Canonical feature-schema acceptance belongs to the feature
   package or a top-level composition acceptance.
6. Inspect file organization. Match the main implementation filename to its
   public factory. Co-locate a small plugin implementation when helpers were
   split only to satisfy an arbitrary line limit; keep separate files only for
   a real reusable, generated, platform, or lifecycle boundary.
7. Run the repository boundary test and focused package checks. For this repo,
   start with:

   ```sh
   pnpm exec vitest run packages/test-utils/src/providerAnalyticsBoundary.repository.spec.ts --project=unit:default
   git diff --check
   ```

   Also run the relevant feature and provider typechecks/tests. Never treat a
   keyword scan alone as proof; verify manifests, import graphs, capability
   tokens, artifacts, and runtime behavior.

8. In a stack, place the fix in the earliest owning PR and propagate with normal
   merges. Re-run the audit after every forward merge.

## Score loop

Score every database provider out of 100 before changing it. Record evidence,
not impressions, for each category:

- Factory contract (20): the public database factory is built with
  `createDatabasePlugin` (directly or through the repository's approved
  `createBlobDatabasePlugin` wrapper), has one obvious entry point, and exposes
  only generic database/component-data capabilities.
- Provider focus (25): source, manifests, IaC, IAM, generated artifacts, and
  public exports contain only database/provider vocabulary. Analytics, access
  keys or tokens, auth roles, and other feature contracts belong to their
  feature plugin or an exact composition root.
- Co-location and navigation (20): a reviewer can read the implementation from
  the factory file without chasing helpers split only to satisfy a line limit.
  Keep a separate file only for a reusable boundary, generated artifact,
  platform entry point, or independently testable lifecycle.
- Declarative mapping (15): model/component schema mapping, indexes, physical
  names, and supported operations are expressed as data or short named
  primitives instead of repeated imperative branches.
- Simplicity and database context (10): abstractions are justified by database
  semantics, nesting is shallow, naming matches the public factory, and no
  speculative extension points exist.
- Verification (10): meaningful synthetic provider conformance, boundary
  checks, typecheck, and focused runtime/migration tests cover the actual
  contract without importing feature schemas into provider tests.

Apply these hard failures before considering the numeric score:

- The database factory uses neither `createDatabasePlugin` nor the approved
  `createBlobDatabasePlugin` wrapper around it.
- Ordinary provider code imports or models Analytics, Better Auth access keys,
  access tokens, auth roles, or another optional feature contract.
- Provider IaC seeds a feature schema, marker, row, or migration directly.
- A provider test passes only by importing a canonical optional-feature schema
  instead of a synthetic component fixture.

For each hard failure, cap the score at 49 until it is removed. A provider is
ready only when it has no hard failures, scores at least 85, and the provider
set averages at least 90.

Iterate deliberately:

1. Produce a baseline table with the six category scores, total, hard failures,
   and exact file evidence.
2. Fix the largest ownership or readability deduction with the smallest
   coherent change. Do not add abstractions merely to gain points.
3. Run the provider's focused typecheck/tests and the repository boundary test.
4. Re-score from the changed source. Do not award points for planned work.
5. Repeat until every provider clears 85 and the average clears 90, or report a
   concrete blocker that needs a product/API decision.

Prefer co-location over a file-count target. A long cohesive adapter is better
than many tiny files when reading it top-to-bottom explains one database
implementation; split only at a genuine ownership or runtime boundary.

## Required invariants

- A database factory must not know Analytics, Better Auth access keys, or any
  other optional feature contract.
- A universal adapter may expose only operations justified across components;
  it must not encode feature tables, versions, retention, roles, or errors.
- Logical component versions come from the feature schema. Provider physical
  layout versions use a separate neutral namespace when truly needed.
- Provider IaC consumes composed schemas/artifacts or generic lifecycle hooks;
  it must not seed feature markers or copy feature DDL.
- Readiness failures remain provider-neutral and are translated by the feature
  package at its public boundary.
- Removing a feature plugin removes its routes/schema contribution without
  requiring ordinary provider source changes.

## Verdict

Report findings first, ordered P0/P1/P2, with exact file paths and evidence.
State which package/PR owns each fix and the smallest acceptable correction.
If no blocker exists, say so and list the checks that substantiate the verdict.
Remain read-only unless the caller explicitly asks to implement fixes.

Run this audit when opening a provider refactor, after adding a feature schema,
after each stacked merge, and immediately before final CI/E2E sign-off.
