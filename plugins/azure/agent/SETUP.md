# Azure setup checklist

Read COMMON.md first. Follow these steps in order and record verified observations
in deployment.json. Use the Azure CLI (`az`) or other authorized Azure tools; paths
below are relative to this scaffold. The azure/function/ directory holds the same
bundled Function package as interactive init: `index.mjs`, `host.json` and
`package.json`, which need no install. Verify `az version` (Azure CLI 2.60.0 or
later, for the Flex Consumption commands) and an authenticated
`az account show` before remote provisioning.

## Upgrade or reconcile an existing deployment

Read upgrades/README.md and the Azure section of each applicable version file
first; a listed change applies before anything below. Then reconcile the
recorded resource group, storage account, Cosmos DB account and Function App
with this scaffold: every step is idempotent and reuses what exists. Repeat
az.database-credential, whose migration creates only what is missing and
refuses a container of another storage layout, then az.function, which sets
the Function App's settings and deploys this scaffold's package, and finish
with az.complete. Reuse the recorded resources and saved client credential;
never create replacements to upgrade. `hot-updater init` with the saved inputs
(`--from-env-file .env.hotupdater`) performs the same checks, migration and
deployment.

## Setup

- [ ] **az.scope — Select the subscription and resource group**
  - Inputs: authenticated account, workspace configuration and established region.
  - Run: list enabled subscriptions (`az account list`) and select the one the
    user names or the only one. Register the resource providers
    Microsoft.Storage, Microsoft.DocumentDB, Microsoft.Web, and
    Microsoft.App (which the CLI requires to create a Flex Consumption app) when
    `az provider show` reports them unregistered, as a new subscription does
    (`az provider register --namespace <namespace> --wait`). List the regions
    that host Flex Consumption
    (`az functionapp list-flexconsumption-locations`): the Function App shares
    the group's region. Query the resource group (`az group show`); reuse it
    only when its region is in that list, or choose a listed region for a new
    one and create it (`az group create`) only after every preflight below
    passed. Stop before creating any resource in a group outside the list. Inspect
    existing Hot Updater resources and the upgrade files before adopting them.
    Preserve unrelated resources.
  - Preflight, before creating the resource group or any storage, Cosmos DB
    or Function App resource, as init does; stop on any failure:
    - Storage account (`az storage account show`): an existing one must be a
      general-purpose `StorageV2` (or `Storage`) account, since the Function
      App's host storage needs Blob, Queue and Table services, must allow
      shared key access, and must not restrict network access
      (`publicNetworkAccess` not `Disabled`, `networkRuleSet.defaultAction`
      not `Deny`): devices download from it, and the setup creates no virtual
      network. A new name must pass `az storage account check-name`.
    - Cosmos DB account (`az cosmosdb show`): an existing one must be API for
      NoSQL (`kind` `GlobalDocumentDB`, no Mongo/Cassandra/Gremlin/Table
      capability), keep key authentication (`disableLocalAuth` and
      `disableKeyBasedMetadataWriteAccess` not true, since the migration
      creates and updates the database and container with the key) and
      write in one region (`enableMultipleWriteLocations` not true), and be
      reachable from the Function App, which joins no virtual network:
      `publicNetworkAccess` not `Disabled`, and with IP or virtual network
      rules, an `0.0.0.0` rule that admits Azure datacenters and a rule that
      admits the machine running the migration (reading the `hot-updater`
      database with the key answers, or 404s, rather than 403). An existing
      `hot_updater_v1` container in the `hot-updater` database must be
      partitioned by `/partition` alone, have no unique keys, and either hold
      a `schema.engine` setting of this version's layout or no items at all
      (`az cosmosdb sql container show`, then a cross-partition
      `SELECT TOP 1 c.id FROM c`). When its default consistency is not
      `Strong`, get the user's approval to change it, since other apps on it
      read under it too, and change it as the last preflight step, before any
      resource is created (`az cosmosdb update --default-consistency-level
Strong`): Azure refuses it for an account whose regions lie more than
      5,000 miles apart unless support enabled global strong consistency, and
      then stop. A new name must be free
      (`az cosmosdb check-name-exists` returns false).
    - Function App (`az functionapp show`): an existing one must be a Flex
      Consumption app on Node.js 22 or later (`properties.functionAppConfig.runtime`)
      that is Hot Updater's: its app settings include
      HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING, or it runs no functions yet
      (`az functionapp function list`). Deploying replaces its whole package. A new name must be free across
      azurewebsites.net (`az rest --method post --url
https://management.azure.com/subscriptions/<subscription-id>/providers/Microsoft.Web/checknameavailability?api-version=2024-04-01
--body '{"name":"<app>","type":"Microsoft.Web/sites"}'`).
  - Verify/record: subscriptionId, resourceGroup, a location that hosts Flex
    Consumption, and the preflight results.
  - Retry: query the same group before another create request.

- [ ] **az.storage — Prepare the storage account**
  - Requires: az.scope.
  - Run: reuse the account az.scope checked, or create a StorageV2, Standard_LRS
    account with TLS 1.2 and blob public access disabled. Shared key access
    must stay allowed: the bundles' SAS URLs and the Function's settings use
    the account key. Create the private `hot-updater` blob container when
    missing, or make an existing one private (no anonymous `publicAccess`):
    devices download bundles through SAS URLs.
  - Verify/record: storageAccount, its region and the container.
  - Retry: query the account and container; never create a second account to
    resolve a naming conflict the user did not approve.

- [ ] **az.cosmos — Prepare the Cosmos DB account**
  - Requires: az.scope.
  - Run: reuse the account az.scope checked (and made `Strong` when the user
    approved it there), or create one: API for NoSQL
    (`--kind GlobalDocumentDB`), serverless (`--capabilities EnableServerless`
    on the core CLI; `--capacity-mode Serverless` when `az cosmosdb create
--help` lists it, as the cosmosdb-preview extension does, whose preview
    API refuses the capability) in
    the group's region, with `Strong` default consistency. Account creation
    takes several minutes.
  - Verify/record: cosmosAccount, API, capacity mode and consistency.
  - Retry: query the account's provisioning state instead of creating it again.

- [ ] **az.database-credential — Create the container, write the schema settings and register the client credential**
  - Requires: az.storage and az.cosmos. Complete this before Function deployment, as init does.
  - Run: read the connection strings (`az storage account
    show-connection-string`, `az cosmosdb keys list --type
    connection-strings`) into the app's ignored .env.hotupdater as
    HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING and
    HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING; never paste them into chat.
    When the `hot_updater_v1` container of the `hot-updater` database exists,
    read its settings item (`pk = private_hot_updater_settings`,
    `row.key = schema.engine`); its `row.value` must be the string `"1"` when
    present. A missing marker is acceptable only for an empty container. Stop
    on any other value, a populated container without the marker, a container
    not partitioned by `/partition`, or an unknown layout; preserve the data
    for investigation. Then follow COMMON.md's Local CLI and client credential
    steps. Run app/provision-client-credential.mjs from the app directory: the
    helper loads app/hotUpdater.ts, the credential helper's server definition,
    which stays in the scaffold and is never copied into the app. The helper
    first runs app/migrate.ts, which creates the database and container when
    they are missing and writes the schema settings of core and the plugins
    app/hotUpdater.ts runs (the database answers 503 until they exist),
    <!-- if credential -->
        then registers the client {{CREDENTIAL_LABEL}}.
  - Verify/record: helper succeeds against the chosen account and the
    {{CREDENTIAL_LABEL}} is persisted privately. Do not create settings items
    by hand.
  - Retry: repeat the compatibility preflight, then rerun the helper with the
    saved {{CREDENTIAL_LABEL}}. Never edit settings to bypass a failed check or
    rotate the {{CREDENTIAL_LABEL}}.
    <!-- else -->
        and registers no client credential, since client routes are public.
  - Verify/record: helper succeeds against the chosen account. Do not create
    settings items by hand.
  - Retry: repeat the compatibility preflight, then rerun the helper. Never edit
  settings to bypass a failed check.
  <!-- end -->

- [ ] **az.function — Deploy the server**
  - Requires: az.database-credential.
  - Run: reuse the app az.scope checked, or create it on a Flex Consumption
    plan (`az functionapp create --flexconsumption-location <location>
--runtime node --runtime-version 22 --storage-account <account>`). Set the
    app settings HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING,
    HOT_UPDATER_AZURE_BLOB_CONTAINER (`hot-updater`) and
    HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING, preserving unrelated settings.
    Zip the three files of azure/function/ at the archive root and deploy them
    (`az functionapp deployment source config-zip --src <zip>`).
  - Verify/record: functionApp, its default host name and baseUrl
    (`https://<defaultHostName>`). host.json drops the `/api` prefix, so the
    host name serves every route.
  - Retry: inspect the deployment status and logs; reuse the same Function App.

- [ ] **az.complete — Verify and report**
  - Requires: az.function.
  - Run: check `<baseUrl>/version` and complete common.verify, common.local and
    common.report in COMMON.md.
  - Verify/record: target version/generation, catalog authentication and local
    configuration pass. Resolve/download an existing artifact when available:
    /version and an empty catalog do not exercise SAS download URLs. Report app
    integration/OTA validation separately from server readiness.
  - Retry: inspect the failing check and corresponding step, preserving verified resources.
