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
