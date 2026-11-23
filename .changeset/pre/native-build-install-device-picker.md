---
"hot-updater": patch
"@hot-updater/apple-helper": patch
---

feat(cli): `native-build install` asks which device to install on when several are booted

With several booted iOS Simulators or connected Android devices, `npx hot-updater native-build install <id>` lists them in a terminal and installs on the one you pick, as `--simulator <udid>` or `--device <serial>` would. Each simulator shows its name, OS, and short UDID. In CI, under `--json`, or without a terminal, it still refuses and names the flag.
