# @hot-updater/lynx-build

Framework-independent Lynx build adapter for Hot Updater. Import `lynx` and
its build contract types from this package's root. The compiler callback
supplies the output directory, main entry, page entries, essential resources,
and native runtime identity. See the [build contract](../../packages/lynx/README.md#build-integration).

The default fingerprint resolves `@hot-updater/lynx` from the application's
installed dependencies and hashes its native inputs. When installed, the
optional `@hot-updater/lynx-sparkling` host contributes its native sources too.
Neither the device SDK nor this adapter requires a JavaScript UI framework.

UTF-8 XML fingerprints exclude the generated fingerprint and signing-key entries
while preserving native values and order. Binary plists and other XML encodings
are hashed as bytes; converting them to UTF-8 XML changes their fingerprint.
Use UTF-8 XML native configuration files when generating and embedding the
initial fingerprint through the CLI.

The compiler callback can also declare `backgroundEntry`, a canonical relative
`.js` path to one self-contained UTF-8 script. The adapter includes this entry in
`hot-updater-lynx.json`; the script remains an ordinary manifest-covered asset,
separate from `pageEntries`. The adapter and native artifact validators reject
missing, empty, malformed UTF-8, NUL-containing, or over-16-MiB scripts.
Declaring the asset alone does not register an OS background task or execute it.
For the supported Android Lynx 4.0.3 standalone runtime, the script must evaluate
to an object with `init({ tt })`; call `tt.NativeModules.HotUpdaterBackground.complete(value)`
from that function. Bundle dependencies into the entry. See the device SDK's
[viewless task contract](../../packages/lynx/README.md#viewless-tasks-on-android)
for completion, native integration, and runtime limits.

The `/integration` entry contains CLI init metadata. Run `hot-updater init --build lynx-build` with a `hot-updater.lynx.ts` compiler callback in the app.
