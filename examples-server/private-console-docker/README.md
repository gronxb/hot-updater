# Private Console Docker

Experimental Docker Compose example for running `@hot-updater/console` behind
an external authentication layer.

- `console` runs the Node console server on the private Compose network.
- `nginx` is the only service published to the host and applies Basic Auth.
- The example password is `admin` / `changeme`; replace `.htpasswd` before use.
- Replace `hot-updater.config.ts` with your real provider configuration and
  inject provider secrets through environment variables.

```bash
docker compose up --build
```

Open `http://localhost:1422` and authenticate through nginx.
