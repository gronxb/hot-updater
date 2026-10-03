# @hot-updater/lynx-build

Framework-independent Lynx build adapter for Hot Updater. Import `lynx` and
its build contract types from this package's root. The compiler callback
supplies the output directory, main entry, page entries, essential resources,
and native runtime identity. See the [build contract](../../packages/lynx/README.md#build-integration).

The default fingerprint resolves `@hot-updater/lynx` from the application's
installed dependencies and hashes its native inputs. When installed, the
optional `@hot-updater/lynx-sparkling` host contributes its native sources too.
Neither the device SDK nor this adapter requires a JavaScript UI framework.

The `/integration` entry contains CLI init metadata. Run `hot-updater init --build lynx-build` with a `hot-updater.lynx.ts` compiler callback in the app.
