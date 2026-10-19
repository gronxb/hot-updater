# @hot-updater/plugin-vault

Hot Updater's vault plugin. It stores signing and deploy credentials in the
server's database as AES-256-GCM ciphertext, under data keys that a master key
wraps. The master key, `HOT_UPDATER_VAULT_MASTER_KEY`, stays in the Console's
deployment, which serves the vault; the plugin adds tables and
`hotUpdater.api.vault`, and no routes.

You don't install it on its own. List `vault()` in the plugins of
`hot-updater.config.ts`, from the CLI's plugin entry:

```ts
import { vault } from "hot-updater/plugins";
```

and in the plugins of `console.config.ts`, from the server's entry:

```ts
import { vault } from "@hot-updater/server/plugins";
```
