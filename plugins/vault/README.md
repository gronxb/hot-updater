# @hot-updater/plugin-vault

Hot Updater's vault plugin. It stores signing and deploy credentials in the
server's database as AES-256-GCM ciphertext, under data keys that a master key
wraps. The master key, `HOT_UPDATER_VAULT_MASTER_KEY`, stays in the Console's
deployment, which serves the vault at `/_hot-updater/vault/v1/`; the plugin
adds tables and `hotUpdater.api.vault`, and no routes. The CLI lists secrets
and manages tokens, and never reveals a value. CI reaches the vault with a `hu_vault_`
token whose scope names the secrets it may use, by name or kind, and its
actions, `read` or `sign`; the database keeps only the token's SHA-256 digest.

You don't install it on its own. List `vault()` in the plugins of
`hot-updater.config.ts`, from the CLI's plugin entry:

```ts
import { vault } from "hot-updater/plugins";
```

and in the plugins of `console.config.ts`, from the server's entry:

```ts
import { vault } from "@hot-updater/server/plugins";
```
