# Cloudflare upgrade

Read COMMON.md and UPGRADE-NOTES.md. Query the existing Worker, bindings, D1
migration history, R2 privacy setting, secret names and /version first. Use the
previous deployment.json to identify the exact account and resources.

Compare the new Worker bundle and Wrangler configuration against the deployed
version. Preserve Worker name/URL, DB and BUCKET identities, signing secret,
client key, routes, custom domains and unrelated configuration. Merge changed
managed settings, including cache settings, rather than replacing the full config.
Apply only pending compatible migrations, then deploy the new runtime and verify
the active version and bindings. If deployment fails after migration, retain
the schema history and retry the code deployment. Do not rotate secrets on retry.

Generation 0 or an unknown schema requires the transition described in
UPGRADE-NOTES.md. A missing /version response must be investigated before adoption.
