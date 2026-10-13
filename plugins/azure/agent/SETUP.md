# Azure setup checklist

Read COMMON.md first. Follow these steps in order and record verified observations
in deployment.json. Use the Azure CLI (`az`) or other authorized Azure tools; paths
below are relative to this scaffold. The azure/function/ directory holds the same
bundled Function package as interactive init: `index.mjs`, `host.json` and
`package.json`, which need no install. Verify `az version` and an authenticated
`az account show` before remote provisioning.

- [ ] **az.scope — Select the subscription and resource group**
  - Inputs: authenticated account, workspace configuration and established region.
  - Run: list enabled subscriptions (`az account list`) and select the one the
    user names or the only one. List the regions that host Flex Consumption
    (`az functionapp list-flexconsumption-locations`): the Function App shares
    the group's region. Query the resource group (`az group show`); reuse it
    only when its region is in that list, or create it in a listed region.
    Stop before creating any resource in a group outside the list. Inspect
    existing Hot Updater resources and the upgrade files before adopting them.
    Preserve unrelated resources.
  - Verify/record: subscriptionId, resourceGroup and a location that hosts
    Flex Consumption.
  - Retry: query the same group before another create request.

- [ ] **az.storage — Prepare the storage account**
  - Requires: az.scope.
  - Run: query the storage account; when missing, check its name
    (`az storage account check-name`) and create a StorageV2, Standard_LRS
    account with TLS 1.2 and blob public access disabled. Shared key access
    must stay allowed: the bundles' SAS URLs and the Function's settings use
    the account key. Create the private `hot-updater` blob container when missing.
  - Verify/record: storageAccount, its region and the container.
  - Retry: query the account and container; never create a second account to
    resolve a naming conflict the user did not approve.

- [ ] **az.cosmos — Prepare the Cosmos DB account**
  - Requires: az.scope.
  - Run: query the account (`az cosmosdb show`). A new account is API for
    NoSQL (`--kind GlobalDocumentDB`), serverless (`--capabilities
EnableServerless`) in the group's region, with `Strong` default
    consistency. An existing account must be API for NoSQL with `Strong`
    consistency; change another account's consistency only with the user's
    approval, since other apps on it read under it too. Account creation takes
    several minutes.
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
    {{CREDENTIAL_LABEL}} is persisted privately. Do not create settings items by hand.
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
  - Run: query the Function App; reuse it only when it is a Flex Consumption
    app on Node.js 22 or later (`functionAppConfig.runtime` in
    `az functionapp show`), since deploying replaces its package. When it is
    missing, check in az.scope, before creating any resource, that its name is
    free across azurewebsites.net (`az rest --method post --url
    https://management.azure.com/subscriptions/<subscription-id>/providers/Microsoft.Web/checknameavailability?api-version=2024-04-01
    --body '{"name":"<app>","type":"Microsoft.Web/sites"}'`). Create it on a
    Flex Consumption plan (`az functionapp create --flexconsumption-location <location>
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
