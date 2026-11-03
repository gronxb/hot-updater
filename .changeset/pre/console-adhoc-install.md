---
"hot-updater": patch
"@hot-updater/apple-helper": patch
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/protocol": patch
---

Install an ad hoc IPA on an iPhone from the Console, and register iPhones from the CLI.

- A build's page on an iPhone checks whether the IPA includes that phone, reading its `Info.plist` and provisioning profiles from storage with HTTP Range requests. It offers "Check this iPhone", then "Install" or "Not in this build", with "Install anyway" second. A storage that answers Range with the whole file shows "Installation details unavailable", and nothing downloads.
- "Check this iPhone" installs a UDID-only profile. The phone lands on a page, which takes no session and reads nothing, with its UDID, one command to send a maintainer, and a copy button. The UDID stays in the phone's `localStorage`.
- Install opens `itms-services` on `/_hot-updater/native-builds/{id}/manifest.plist?t=`, which verifies its download token before any read and mints nothing. An Install link lasts about an hour.
- `native-build devices add --udid <UDID> --name <name>` (`--udid` repeats) registers iPhones in App Store Connect, each at most once, and `native-build devices list` reads them back. The Console never holds an Apple key.
- `native-build ios` prints how many devices the `.ipa` lists, and with `--udid` whether each is included. A sandbox scheme can export with `release-testing`.
- A pull request preview's QR code of an IPA holds the build's page, through `/_hot-updater/native-builds/qr?target=page`, which stays anonymous and reads nothing.
- `@hot-updater/protocol/native-artifact` adds `readIpaInstallInfo`, `readProfileServiceUdid` and `normalizeIosUdid`. Its plist parser now reads crafted XML in linear time.
- An ad hoc export in CI signs in the build's own keychain, and only its development certificates are revoked.
- An iOS build's output and cache hold only the `.ipa` of its export. Xcode's `Packaging.log`, which holds the API key's bearer token for 20 minutes, no longer reaches `.hot-updater/output`. Build logs mask any JSON Web Token.
