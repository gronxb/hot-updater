---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/server": minor
"@hot-updater/plugin-core": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

A managed server runs the project's server definition. When `hotUpdater.ts` differs from the one `hot-updater init` writes, for example with a third-party plugin or without `insights()` or `apiKeys()`, init bundles it into the managed Worker, Edge Function, Lambda@Edge function, or Cloud Function. There, the provider's database and storage are the ones init set up, whatever settings the definition passes. `hot-updater init --provider <provider> --build <build> --from-env-file .env.hotupdater` redeploys it.

- The definition's database and storage must be the provider's, on the bucket, table, D1 database, or project init set up. Init refuses anything else before it creates or changes a resource, and its errors name the definition file and say what to do.
- The deployed bundle is minified, with function and class names kept, and carries no path from the machine that bundled it.
- Init creates the tables and settings rows of the plugins the definition lists. A plugin the definition drops keeps its tables and rows. The package's base migration holds core's tables only, and the infrastructure scaffold ships the prebuilt server's plugin migration after it.
- Rerunning init with another `--provider` replaces the definition the previous provider's init wrote. A definition the project wrote for another managed provider is refused before init touches a resource, and the message says how to deploy it.
- On AWS, the function's role reads core's tables and the listed plugins' tables, and writes only the plugins' tables and the aggregate log and lease. The role also keeps the access of the versions the distribution may still run, including after an init that failed partway. The first init after the distribution reports the new version as Deployed removes that access. Init refuses a server definition whose plugins' tables would take the role past IAM's policy size limit, and names the plugins.
- CloudFront sends each plugin's client endpoints to the function uncached, with the request's headers, cookies, and query string. Init refuses an endpoint under `/bundles` or `/assets`, or one that starts with a parameter such as `/:id`, because CloudFront serves bundles from S3 there. A plugin the definition drops loses its CloudFront behavior.
- Init names its CloudFront cache and origin request policies after their settings and never changes an existing one, so two distributions in one account keep their own. After updating the distribution, it deletes Hot Updater's policies that no distribution uses, such as rc.20's, and it makes a policy again when another init deleted it first. The function's zip must stay under Lambda@Edge's 50 MB limit.
- `ServerDefinition` from `@hot-updater/server/db` lists the plugins' `clientEndpoints`. `@hot-updater/cli-tools` adds `bundleServer`, `readManagedServerDefinition`, `loadManagedServerDefinition`, `replacingServerDefinitions`, and `moduleSpecifiersOf`, and init providers list their `serverDefinitions`.
