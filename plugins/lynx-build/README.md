# @hot-updater/lynx-build

Framework-independent Lynx build adapter for Hot Updater. Import `lynx` and
its build contract types from this package's root. The compiler callback
supplies the output directory, main entry, page entries, essential resources,
and native runtime identity. See the [build contract](../../packages/lynx/README.md#build-integration).

The default fingerprint resolves `@hot-updater/lynx` from the application's
installed dependencies and hashes its native inputs. When installed, the
optional `@hot-updater/lynx-sparkling` host contributes its native sources too.
Neither the device SDK nor this adapter requires a JavaScript UI framework.

The compiler callback can also declare `backgroundEntry`, a canonical relative
`.js` path to one self-contained UTF-8 script. The adapter includes this entry in
`hot-updater-lynx.json`; the script remains an ordinary manifest-covered asset,
separate from `pageEntries`. The adapter and native artifact validators reject
missing, empty, malformed UTF-8, NUL-containing, or over-16-MiB scripts.
Declaring the asset alone does not register an OS background task or execute it.

The `/integration` entry contains CLI init metadata. Run `hot-updater init --build lynx-build` with a `hot-updater.lynx.ts` compiler callback in the app.
