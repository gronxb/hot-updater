# Real CLI packaging and local OTA service evidence

Recorded: 2026-09-11. Worktree: `codex/lynx-support` at
`/Users/gronxb/workspace/hot-updater-lynx`.

## Scope and outcome

The built Hot Updater CLI completed 30 verified deployments using real frozen
ReactLynx, VueLynx and OctaneLynx compiler output. Six ZIP deployments cover all
framework × iOS/Android cells. Further deployments cover TAR.GZ, TAR.BR, genuine
multiple-template output from each framework, and configured RSA signing. Six subsequent SDK1 B deployments target the
confirmed public OTA profile IDs and framework channels. Two further signed
deployments verify the public signing resolver with actual native projects present.
Six SDK3 deployments then publish the corrected runtime and full resource set
under the approved native `ota-v2` profiles.
Every recorded deployment uploaded actual bytes over HTTP, committed a Bundle
and distinct Release through the existing standalone repository, and returned its
Release through the server's public catalog route.

The initial 16 deployments and two signing-resolver deployments are G2 packaging/provider evidence for private G1 host
profiles. The six SDK1 and six SDK3 deployments exercise packaging and real catalog scopes for
their confirmed public OTA profiles. These packaging checks do not establish native
installation, correct execution of every dynamic component, public SDK support,
or G3 recovery. Existing recorded private artifacts remain unchanged.

## Execution and provider contracts

The producer is [ota-deploy.mjs](../../../examples/lynx/scripts/ota-deploy.mjs).
It creates an ignored task-local CLI project with a minimal private package.json
and a real hot-updater.config.mjs, invokes `@hot-updater/lynx/build`, copies the
selected frozen output into the adapter-owned directory, and returns the explicit
native compatibility identity. The adapter returns `filePolicy: "preserve"`.

The script spawns the built CLI executable as a child process. For example, the
recorded React/iOS ZIP invocation was:

```text
Executable: /Users/gronxb/.local/share/mise/installs/node/24.15.0/bin/node
Working directory: /Users/gronxb/workspace/hot-updater-lynx/examples/lynx/.hot-updater/ota/projects/react-ios-B-external2-managed-zip-c5949f82-efa8-4a7d-8c0e-044176552e63
Command: node /Users/gronxb/workspace/hot-updater-lynx/packages/hot-updater/dist/index.mjs deploy -p ios -t 1.0.x -c lynx-react-ios-B-external2-managed-zip -o <working-directory>/output -m "Lynx real compiler packaging react-ios-B-external2-managed-zip"
```

Every receipt contains the exact argument array, working directory, build output,
CLI log path, catalog identity/generation/hash, release and bundle IDs, original
server artifact response, archive size, and every final file's SHA-256.
The CLI was rebuilt with `pnpm --filter hot-updater build` after the preserve
helper review fixes; its build log is `/tmp/lynx-ota-cli-build.log`.
The executable's SHA-256 measured at the initial packaging audit was
`e12845975b5f97aebd316899686ccf5a216a37f97d88cdd149d7d9c979488c22`.

[ota-server.mjs](../../../examples/lynx/scripts/ota-server.mjs) runs
`createHotUpdater` with the existing Kysely adapter, persisted PGlite and the
existing schema migrator. The CLI uses `standaloneRepository` and
`standaloneStorage`. The local filesystem storage implementation validates
hierarchical `lynx-local://ota/<key>` URIs and writes uploads through temporary
files and rename. Public catalog/artifact handlers are the library's handlers;
management requests use a task-local bearer credential. No mock database,
fabricated successful commit, external cloud infrastructure or dry run is used.

Resolved database dependencies: PGlite 0.4.1, Kysely 0.28.17,
kysely-pglite-dialect 1.2.0. Node is 24.15.0. Server/schema state and settings
persist under `examples/lynx/.hot-updater/ota/postgres`; objects persist under
`examples/lynx/.hot-updater/ota/objects`. The authenticated Bundle query returned
23 rows after SDK1 publication: the 22 verified deployments below plus the
initial CLI diagnostic run.
The diagnostic run committed successfully, but its first observer incorrectly
expected a separate manifest hash in the standard artifact response. It is not
counted among the verified receipts.

## Six-cell ZIP archive verification

All source roots are `examples/lynx/.hot-updater/g1/<framework>/B-external2-managed`.
Every ZIP contains these five compiler-selected files, with unchanged bytes:
`main.lynx.bundle`, `assets/bootstrap.js`, `assets/probe.png`,
`assets/probe.ttf`, and `assets/OFL.txt`. The final archive adds only
`hot-updater-lynx.json` and `manifest.json`.

The script downloaded each final uploaded archive from the service, extracted
it with the CLI's actual ZIP/TAR dependencies, compared exact names and source
bytes, verified every manifest asset hash, verified the manifest's stored token,
and checked sidecar schema, Bundle ID, OS, main entry and runtime identity.
It re-read the frozen input after deployment to check that it was unchanged.

| Framework / OS | Bundle ID | Release ID | Archive bytes | Archive SHA-256 |
| --- | --- | --- | ---: | --- |
| octane / android | `01a08ed4-97d1-7617-bdd7-4f0ed233e7fe` | `01a08ed4-98f2-7680-9d9d-7be03be41c2d` | 204844 | `a6c3a671582b8750cefc0255eeeb09206c5f31a18c417c54957c77cfafe63d33` |
| octane / ios | `01a08ed4-97e5-7266-a5f8-9166bce6dc92` | `01a08ed4-990c-78c6-b742-627ffdcb079a` | 204843 | `c6faa159c17b74e604d039fa98e53aa7a3389c9ddddc924f113d3e93635578f2` |
| react / android | `01a08ed4-97d0-7d13-a1a6-311f63f92265` | `01a08ed4-9895-7341-a100-85032af1fede` | 80252 | `36ac00b23e21f6fe5b84908c3ac80f6b5f1a1bcb09121eede8bdb22ec2f54ab7` |
| react / ios | `01a08ed3-bc50-7946-9680-f78f69f4809f` | `01a08ed3-bca0-7ebb-8a13-8bcaec82f527` | 80248 | `fdda278d983d4769efc8297ab9dafd40d1cf91ce8497494448a163c56878cd5a` |
| vue / android | `01a08ed4-97d0-7a45-9b59-ed70e313a7ef` | `01a08ed4-98c8-7cdd-9563-627508cd0bd5` | 127693 | `918d1e5399d915cd2912fe1906b5ecaaef6fbbded76ee07c6cfa28848c02c6fb` |
| vue / ios | `01a08ed4-97d1-76b5-a897-a52c813ecf16` | `01a08ed4-9898-790a-aa53-e9eee08a9296` | 127689 | `1a7bd071048e6a2d573f389e8db32fac5043142cf8c2643dae83cc16e2a42e56` |

Native compatibility identities supplied for these private-host artifacts:

- iOS: `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2`
- Android: `android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-spike1`

Stable native probe receipts are served at
`http://127.0.0.1:18791/receipts/<framework>-<platform>.json`.
They contain the actual archive URLs and hashes. Full receipts and downloaded
archives remain under the ignored `receipts/` and `projects/` directories.

## Additional formats, multiple bundles and signing

| Framework / OS | Frozen fixture | Format | Verification | Bundle ID | Archive SHA-256 |
| --- | --- | --- | --- | --- | --- |
| octane / android | B-resources2-managed | zip | SHA-256 | `01a08ed8-7625-7124-b6fa-8001a70d4963` | `6964d4e5521c7ad641fde6de461c48e343874bac27939bad284e76e29fba3cd4` |
| react / android | B-external2-managed | tar.gz | RSA signed | `01a08ed7-7a43-7520-b30f-5f872e1c43a3` | `b2804cb268930de8f75f62e8b094310087ecd2a51d54b71093851a4bd93c7f5a` |
| react / android | B-external2-managed | tar.gz | SHA-256 | `01a08ed5-ae54-7f1e-a29d-54c63e5017c1` | `875c4572ab80419f35bb6d1e683356885c7a48a1e175b9e4ab47ecd81c00dd7d` |
| react / android | B-external2-managed | zip | RSA signed | `01a08ed7-2b52-7661-9c40-f70232cf33e8` | `eb226224de57c8790793e341e15661e5d87615ec87177b73812631c0b287eb46` |
| react / ios | B-external2-managed | tar.br | RSA signed | `01a08edc-a276-77ba-8367-84694219bebf` | `f8b8820599d3b4b3050e07f74be4163b72eca29ded59b89e5c9575082edfddd3` |
| react / ios | B-external2-managed | tar.br | SHA-256 | `01a08ed5-ae56-7ca3-b0e6-5364a58d1090` | `4a872697599bbd5df742e9c9eefef8032470bc0ac2ffaf20b08fbd3fe9035694` |
| react / ios | B-external2-managed | tar.gz | RSA signed | `01a08edc-a276-7d23-ad7e-a4af6a67dec7` | `d8a5d00ae9a1dcb822d6e75e48b8a162549546c0474fb7bcb3e96dc2563bc3fe` |
| react / ios | B-external2-managed | zip | RSA signed | `01a08ed7-7a43-7f6e-be29-417ed63edee2` | `c473b48bdc1782e7bf12a22dfa9ff1ebd5067621c497876607c264952a2c6da2` |
| react / ios | B-resources2-managed | zip | SHA-256 | `01a08ed5-ae56-75b6-8387-a4acb94f5c1a` | `a36f78d1b11f3575c526e47bf55ca00f7ab44d902bd23fdce57e07151612e59e` |
| vue / ios | B-resources2-managed | zip | SHA-256 | `01a08ed8-7627-7792-947f-a8f9145c63c4` | `72c64b2cd9d0a6bcc4acca3b8bec5e91b9670207f1eb1e38abcfa4f52edeba38` |

The `B-resources2-managed` artifacts contain the genuine compiler-emitted
`main.lynx.bundle` and `async/bootstrap.<compiler-hash>.bundle`, with the image,
font and license files. No file was renamed to simulate a second native bundle.
The archive inspection passed for each framework. The known Vue/Octane
`loadLazyBundle is not a function` execution failures described in
[framework evidence](./frameworks.md) remain separate from packaging success.

Signed runs use the CLI's existing local PEM signing configuration. Independent
verification with the corresponding RSA public key passed for the archive,
manifest and every asset signature. The server's `sig:` tokens are preserved.
The native public PEM is
`examples/lynx/.hot-updater/ota/signing/public-key.pem`; its DER SPKI SHA-256 is
`34d6c30b46c7ecf1fd0e2b90d69b128f670ff519d4a0ffc2f93746652d48f706`.
The task-local private PEM has mode 0600, is outside served directories, and
stays in the CLI harness. The private key was not printed or shared.

Signed ZIP probe receipts are `/receipts/react-ios-signed.json` and
`/receipts/react-android-signed.json`. The signed Android TAR.GZ receipt is
`/receipts/react-android-B-external2-managed-tar-gz-signed.json`.
The unsigned baseline receipts remain available for configured-key rejection
scenarios. Native rejection results belong to the native evidence files.

The standard `/artifacts/<bundle>/from/00000000-0000-0000-0000-000000000000`
response returns the archive URL/token and omits `manifestFileHash` in these
runs. Probe receipts preserve that transport value as `null`.
`persistedManifestFileHash` records the authenticated Bundle row independently
for packaging audit; it is not substituted into the server response. Native
installers must verify the full archive and its contained manifest, adding the
separate manifest-token check only when the server supplies that token.

## Public signing resolver with native projects present

After the public resolver seam and CLI were rebuilt, the harness passed
`getBundleSigningPublicKey` directly to `lynx()`. It no longer decorates the
returned BuildPlugin's `nativeBuild` object. Each task project contains symlinks
to the real example's `ios` and `android` directories. The applicable native
configuration file was read and its SHA-256 recorded before invoking the CLI.
Lynx declares `signingConfigSource: "build-plugin"`, so the public resolver owns
the signing key even when native project files exist.

Both real CLI deployments below uploaded and committed successfully; independent
archive, manifest, asset, signature and frozen-input checks passed. Their private
host profiles and distinct delivery scopes preserve the public SDK1 catalog and
all earlier native probe receipts. The rebuilt executable SHA-256 for these runs
was `57ae52cb349419c9f524a4fec0c12880618e71daa678ee1ffeb36e912cabadca`.

| OS / fixture / format | Bundle ID | Release ID | Archive SHA-256 |
| --- | --- | --- | --- |
| Android / B-external2-managed / TAR.BR | `01a08efd-8a8a-7d24-a9f3-6a9d07a54c52` | `01a08efd-8bec-7660-b343-64deb7147f4d` | `35ecb81a4fd7b0e6b3ea5cc1d0f1fd26cfeec0bffe8817e5079e78332774561d` |
| iOS / A-external2-managed / ZIP | `01a08efd-d987-77a3-9bcd-751f607fdf1d` | `01a08efd-db2e-7148-9d9c-2b21fc1730e9` | `58715ae490674fdd2eea934c20e93324034eedbc42b71fb81152af0a9d58ea52` |

Exact invocations, native configuration paths and hashes are in
`receipts/react-android-B-external2-managed-tar-br-signed.json` and
`receipts/react-ios-A-external2-managed-zip-signed.json`. The same scoped public
key and real nullable artifact-response manifest hash are retained.

## SDK1 public-profile publication

The primary agent confirmed these exact native-owned profiles before publication:

- iOS: `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v1`
- Android: `android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v1`

The native configuration owns channels `ota-react`, `ota-vue`, and `ota-octane`.
The frozen `B-sdk1-managed` fixtures contain two files: the actual framework
entry importing the public SDK and its image dependency. Six additional real
CLI deployments verified exact source preservation and metadata binding under
those profiles. Native hosts must embed the matching profile before evaluating
these artifacts. Expanded SDK2 resource scenarios are still required for G3.

| Framework / OS | Channel | Bundle ID | Release ID | Archive SHA-256 |
| --- | --- | --- | --- | --- |
| octane / android | `ota-octane` | `01a08edf-f7fe-7c94-b0a0-cf32b4470e8e` | `01a08edf-f935-73ff-be78-35b05bdefba5` | `5e368952126b7801182a92378a62a1bd6080295e012cd333852f194c6a3ed8ff` |
| octane / ios | `ota-octane` | `01a08edf-f7ff-7ca9-a402-7b877e5506a8` | `01a08edf-f959-7101-8c49-7a6b324adbc2` | `024ce023a43b7e0d26c4b4fbf2764604f2be5e9851376a208655270dcc235ac2` |
| react / android | `ota-react` | `01a08edf-f800-71d1-b7fe-15859987e390` | `01a08edf-f8cd-7f5f-8753-415ecefc6237` | `a060594155b5ce6c63e07c37104aa1da6a2e2548c08eb1e7e3a5898b9af8e79d` |
| react / ios | `ota-react` | `01a08edf-f7fe-72c8-8862-b170c42ce884` | `01a08edf-f8d1-7033-b08c-f07c7d83be0e` | `2bb921cc5b678e2dae8056e87ddf39aef385ba0da93e3bdd53febd695693425d` |
| vue / android | `ota-vue` | `01a08edf-f7fe-7cbd-a50b-f9214ed7961f` | `01a08edf-f914-79da-8eab-e925da03b0fa` | `64c456d205e50ecb3fd9355a19c0f76efe80459ad1c0f282945651a30e86564b` |
| vue / ios | `ota-vue` | `01a08edf-f804-7dee-8de2-2d68c542d34b` | `01a08edf-f933-73a8-936b-b9c3a3135155` | `3d1138bed90a2f43cf7e3080c1854c9ca7df27b1b6a233596a84182fa54381b9` |

Receipts are `/receipts/<framework>-<platform>-B-sdk1-managed-zip.json`.
The standard public catalog/artifact URLs in each receipt were fetched and
checked for the actual Release-to-Bundle binding. Transport `manifestFileHash`
remains null. The earlier private-host receipt aliases were preserved.

The harness requires explicit `--runtime-id` and `--channel` for SDK fixtures;
an attempted SDK deployment without them was rejected before invoking the CLI.
For example:

```sh
node examples/lynx/scripts/ota-deploy.mjs react ios zip B-sdk1-managed --runtime-id sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v1 --channel ota-react
```

## Native embedded A identity and SDK2 preparation

[ota-embedded.mjs](../../../examples/lynx/scripts/ota-embedded.mjs) prepared
all six framework/OS cells for each of `A-sdk1-managed` and `A-sdk2-managed`.
It calls the actual public Lynx build adapter to validate and copy the frozen
compiler output. That validated OTA output retains its generated Bundle ID.
The script then copies it into a separate native-owned embedding directory and
binds the approved NIL embedded identity in the copied sidecar. The actual CLI
preserve selector, manifest builder and manifest writer generate its manifest.
There is no Bundle or Release insertion for embedded A.

Each of the twelve receipts distinguishes `validationBundleId` and
`validatedBuildPath` from the native `embeddedBundleId`/`minimumBundleId`
(`00000000-0000-0000-0000-000000000000`). It records the explicit native OTA profile,
final output directory, manifest hash and every file's hash. All original
compiler files match byte-for-byte, and both the frozen source and the separate
validated OTA output were re-read and found unchanged. Receipts are
`receipts/<framework>-<platform>-A-sdk<N>-managed-embedded.json`; each immutable
native output also has an adjacent receipt. SDK1 has two raw compiler files;
SDK2 has six, including the external JS and native dynamic-component bundle.

The frozen SDK2 B and recovery fixtures remain available but were not published.
Android SDK1 reached public launch information and readiness, then its update
check failed before native preparation because the pinned PrimJS lacks
`String.prototype.normalize`, used by shared cohort normalization. SDK2 embeds
the same obsolete runtime. The primary agent directed a native-owned canonical
`channelKey` bridge field and an `ota-v2` profile bump for SDK3. SDK1/SDK2 source,
packaging receipts and failed native evidence remain preserved. SDK2 packaging
is not a passing public SDK scenario. These local embedding checks do not
establish native startup or resource execution.

```sh
node examples/lynx/scripts/ota-embedded.mjs react android A-sdk2-managed android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v1
```

## SDK3 publication after native channel-key correction

Both native owners explicitly released their SDK1 catalog scopes before this
publication. The corrected runtime receives its canonical channel key from the
native bridge, requiring new native-owned compatibility profiles:

- iOS: `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2`
- Android: `android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2`

All six SDK3 A native NIL trees and six SDK3 B CLI deployments passed the same
source, metadata and manifest checks described above. The framework producer's
`sdk3-summary.json` records consumed runtime SHA-256
`a1eb27a0a47fdd0c4cefd1eeb588b55fbe30034e1c8bf86f7f59349478d31a52`.
Every archive preserves these six genuine compiler files: `main.lynx.bundle`,
`dynamic/component.lynx.bundle`, `assets/bootstrap.js`, `assets/probe.png`,
`assets/probe.ttf`, and `assets/OFL.txt`. Each final archive also has the bound
Lynx sidecar and CLI manifest. SDK1/SDK2 frozen source and prior receipts were
preserved. The harness rejects SDK3 attempts that declare an `ota-v1` profile.

| Framework / OS | Bundle ID | Release ID | Archive SHA-256 |
| --- | --- | --- | --- |
| react / ios | `01a08f08-b893-7034-9cee-4bd3404cdcb7` | `01a08f08-bfed-7ff8-8c0f-41693ee30ef0` | `a9e494ba6e293c618979a18298d8db23087fbe046d354e9e1e58ce4f66cc151d` |
| react / android | `01a08f08-58e2-7afa-b6d3-69693640f45f` | `01a08f08-5b01-7539-9a49-da3d596107d9` | `979e4e1a351a3decb9acd36cd51e569012e0ea98a6ce8fa7c9c6b00150ea818b` |
| vue / ios | `01a08f09-aca2-7816-aa2a-608b77a2cfe8` | `01a08f09-adc2-7db3-8f21-1b1ae39bcc6a` | `745661d69a691ce0bcc4227927704bbf0c41d541107d555afa3f01d6c232789a` |
| vue / android | `01a08f09-a76d-7cbf-9f2a-51ea33fa1421` | `01a08f09-a886-708b-8012-88eea186d2c9` | `5b2d2964722c1b5e5000691afe452c5c75b0c065d5bb62f5a92909d33bd42972` |
| octane / ios | `01a08f09-b48e-7044-83fd-fd19de4bfd07` | `01a08f09-b59f-70fd-bb65-ee2f3f3ba9ab` | `c174f68727b121d3b7121e488112095c07fac8e2e27b53f0499c092effd1fc54` |
| octane / android | `01a08f09-afe6-79ee-aea8-6cab981c2e26` | `01a08f09-b135-7b72-869c-4128d637cb82` | `215f9494bbe2c5c0de2cba53e8c296a391248393f57b403450a8ee8831a036a5` |

Native A receipts are `receipts/<framework>-<platform>-A-sdk3-managed-embedded.json`;
B receipts are `receipts/<framework>-<platform>-B-sdk3-managed-zip.json`.
The actual catalog routes returned the new Releases in `ota-react`, `ota-vue`
and `ota-octane`; downloaded archives and stored manifest hashes matched.
The server's artifact response still omits the separate manifest token, recorded
as null without substituting the authenticated audit hash. Exact CLI invocation,
logs and real native configuration presence are recorded per receipt.

These scopes are now reserved for normal SDK3 native verification. The frozen
SDK3 unconfirmed and duplicate-readiness fixtures have not been published;
recovery publication requires coordination with the native scope owners.

```sh
node examples/lynx/scripts/ota-deploy.mjs react android zip B-sdk3-managed --channel ota-react --runtime-id android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2
```

## Isolated HTTP interruption controls

[ota-network-qa.mjs](../../../examples/lynx/scripts/ota-network-qa.mjs) runs a
separate task-owned server on `127.0.0.1:18792`, keeping the live catalog/storage
server untouched. Recorded PID is **72096** (exec session 26616), also written to
`examples/lynx/.hot-updater/ota/network-qa.pid`. The log is
`examples/lynx/.hot-updater/ota/network-qa.log`. Stop this recorded process with
`kill -TERM 72096` after coordinating with native probes.

For any existing stored object key such as `bundles/<bundle-id>/bundle.zip`:

- `/qa/slow/<key>` sends 16 chunks over approximately six seconds and completes
  with the exact original bytes.
- `/qa/truncated/<key>` advertises the complete Content-Length and closes the
  connection after sending half the body.

Actual HTTP checks verified that a completed slow response matched the signed
archive SHA-256, the truncated body was rejected as incomplete, and cancellation
after the first received chunk closed a real partial response. Native
interruption/cleanup behavior remains part of device verification.
Android emulator-5558 may reverse port 18792 independently. The server exposes
stored objects only; it has no catalog mutation or private-key route.

## Reproduction and service lifecycle

From the worktree root, start the local service:

```sh
node examples/lynx/scripts/ota-server.mjs
```

Deploy and inspect one real artifact, choosing framework/OS/format as needed:

```sh
node examples/lynx/scripts/ota-deploy.mjs react ios
node examples/lynx/scripts/ota-deploy.mjs react android tar.gz
node examples/lynx/scripts/ota-deploy.mjs react ios tar.br
node examples/lynx/scripts/ota-deploy.mjs vue ios zip B-resources2-managed
node examples/lynx/scripts/ota-deploy.mjs react android zip B-external2-managed --signed
```

The script requires the frozen compiler output and existing built workspace
packages. It does not install dependencies, run a framework compiler or mutate
native projects. Each invocation creates a fresh Bundle/Release, retaining its
full receipt in that attempt's project directory.

The live service binds only `127.0.0.1:18791`. Recorded PID is **66327**
(exec session 28796). `/health` reports the current PID;
`examples/lynx/.hot-updater/ota/server.pid` stores it.
The live log is `examples/lynx/.hot-updater/ota/server.log`.
Stop this recorded process with `kill -TERM 66327`; coordinate with native
probes first. The service has been left running at the primary agent's request,
so a stop/restart persistence check has not been performed during those probes.

For Android emulator-5558, `adb -s emulator-5558 reverse tcp:18791 tcp:18791`
keeps the provider's localhost URLs unchanged. The emulator host alias
`10.0.2.2:18791` also addresses the same task server when used as an explicit
probe transport override. Native profiles must enable the intended local HTTP
transport for this test. This local setup does not establish production TLS.

Native-owned synthetic negative fixtures may be written to
`examples/lynx/.hot-updater/ota/objects/qa/<ios|android>/` and downloaded from
`/files/qa/<ios|android>/<filename>`. They are intentionally invalid installer
inputs and are not successful catalog deployments. Management without its
credential returned 401; the private-key HTTP path returned 404.
