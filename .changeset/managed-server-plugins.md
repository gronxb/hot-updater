---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/server": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

A managed server runs the project's server definition. When `hotUpdater.ts` differs from the one `hot-updater init` writes, for example with a third-party plugin or without `insights()` or `apiKeys()`, init bundles it into the managed Worker, Edge Function, Lambda@Edge function, or Cloud Function. There, the provider's database and storage are the ones init set up, whatever settings the definition passes. `hot-updater init --provider <provider> --build <build> --from-env-file .env.hotupdater` redeploys it.

- The definition's database and storage must be the provider's. Init refuses any other database or storage before it deploys the server.
- Init creates the tables and settings rows of the plugins the definition lists. The package's base migration holds core's tables only, and the infrastructure scaffold ships the prebuilt server's plugin migration after it.
- Rerunning init with another `--provider` replaces the definition the previous provider's init wrote. A definition the project wrote for another managed provider is refused before init touches a resource, and the message says how to deploy it.
- On AWS, the function's role reaches only the tables of the listed plugins. CloudFront sends the plugins' client endpoints to the function, except under `/bundles` and `/assets`, where it serves bundles from S3. The function's zip must stay under Lambda@Edge's 50 MB limit.
- `@hot-updater/server/db` adds `managedServerDefinitionOf`, and `ServerDefinition` lists the plugins' `clientEndpoints`. `@hot-updater/cli-tools` adds `bundleServer`, `readManagedServerDefinition`, `importManagedServerDefinition`, and `replacingServerDefinitions`, and init providers list their `serverDefinitions`.
