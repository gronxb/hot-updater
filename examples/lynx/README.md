# Lynx native feasibility example

This example executes G1 of the [Lynx PRD](../../plans/lynx-support/prd.md).
ReactLynx, VueLynx, and OctaneLynx use production native compilers, a shared private
bridge probe, and the native hosts in `ios/` and `android/`. Native OTA support is
not complete. See the [execution ledger](../../plans/lynx-support/execution.md)
and [framework evidence](../../plans/lynx-support/evidence/frameworks.md) for
verified results and remaining work.

## Public example builds

The ordinary build now uses the public SDK and includes the entry, image, font,
external background JavaScript, and native dynamic template. Supply the delivery
endpoint explicitly:

```sh
HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater pnpm --filter @hot-updater/example-lynx build
HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater pnpm --filter @hot-updater/example-lynx build:public octane A /absolute/pinned-octane-source
```

The first command builds React and Vue into `dist/<framework>`. Octane uses the
pinned source checkout described below. The same compiler wrapper feeds
`build:hot-updater`, which adds the packaging Bundle ID and native compatibility
metadata. For example:

```sh
HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater pnpm --filter @hot-updater/example-lynx build:hot-updater react ios <native-runtime-id> B
HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater pnpm --filter @hot-updater/example-lynx build:hot-updater octane android <native-runtime-id> B /absolute/pinned-octane-source
```

Use the actual host's compatibility identity and public native module. The
private feasibility commands below remain explicit probes; successful public
compilation alone does not establish the native acceptance matrix.

## Production fixture builds

From the repository root:

```sh
pnpm install
pnpm --filter @hot-updater/example-lynx build:spike react A normal resources
pnpm --filter @hot-updater/example-lynx build:spike react B normal resources
pnpm --filter @hot-updater/example-lynx build:spike vue A normal resources
pnpm --filter @hot-updater/example-lynx build:spike vue B normal resources
pnpm --filter @hot-updater/example-lynx test:type
```

These commands write to
`.hot-updater/g1/<framework>/<A|B>-resources-managed/` inside this example.
`main.lynx.bundle` is the actual main entry; preserve the complete emitted tree,
including `async/*.bundle`, `assets/probe.png`, `assets/probe.ttf`, and its font
license. Adjacent `*.build.json` files record every emitted file's size and SHA-256
outside the artifact tree. They are build evidence, not trusted OTA metadata.

The optional behavior argument is `normal`, `unconfirmed`, `fatal`, or
`double-ready`. The latter waits for two real native readiness replies. The
`fatal` fixture throws during asynchronous bootstrap; the native host must record
its actual error severity. Default resource mode `basic` checks only the image and
native bridge. Non-default behavior is included in the output
name, e.g. `B-unconfirmed-resources-managed`. `C` is also accepted for sequential
unconfirmed-attempt scenarios. Every rebuild replaces its named compiler output;
stage an immutable copy before using it in a native evidence run.

A is blue with Inter Regular; B/C are red with Inter Black. The image and font
paths remain the same while their bytes differ. All managed URLs use the
compiler-declared `hot-updater:///` prefix. A runtime must map this namespace to
the selected release; a generic Lynx viewer is insufficient. The earlier
`asset:///` fixture failed Android's image-resolution test because Fresco opened
APK assets directly.

## Pinned-source Octane build

The inspected Octane Lynx renderer and compiler plugin are private upstream
packages. Use the real pinned checkout and its workspace dependencies:

```sh
git clone https://github.com/octanejs/octane.git /tmp/hot-updater-octane
git -C /tmp/hot-updater-octane checkout c31f629185f7d768c821557f6fb49dc46daf671c
(cd /tmp/hot-updater-octane && pnpm --filter @octanejs/rspeedy-plugin... install --frozen-lockfile --ignore-scripts)
pnpm --filter @hot-updater/example-lynx build:octane /tmp/hot-updater-octane A normal resources
pnpm --filter @hot-updater/example-lynx build:octane /tmp/hot-updater-octane B normal resources
```

The script checks the commit and rejects tracked source changes. It copies this
repository's authored fixture and a real private native-access dependency into a
unique temporary example below the upstream compiler package, invokes production
`rspeedy build --environment lynx`, then removes that temporary source. It never
patches the upstream renderer or substitutes a simulated compiler or native module.
Output goes to the same `.hot-updater/g1/octane/` structure.

Octane compiles application source into both execution graphs and rejects direct
`NativeModules` references and static platform imports in its main-thread graph.
The private dependency under `spike/native-package/` exposes deferred native
access as ordinary installed JS. Its import is inert; an Octane background
`useEffect` invokes it. This tests the eventual packaged-SDK boundary without
freezing a public API. Real callback success must still be observed on each OS.

## Startup probe

React `useEffect`, Vue `onMounted` with initial-frame rendering enabled, and
Octane `useEffect` begin the same background bootstrap. It requires a successful
`getLaunchInfo` callback, the expected asynchronous `probeError` failure envelope,
and an image `load` event. Resource fixtures additionally execute the emitted
lazy chunk and request the packaged font with `lynx.addFont` before calling
`notifyReady`.

These app callbacks do not alone confirm startup. Native owns attempt/context
identity, observes initial content, attributes the ready call, and records actual
resource bytes. The JS font callback does not prove the selected font bytes; use
native resource-loader logs. No JS-supplied bundle or attempt ID grants authority.

`build:hot-updater` and `build:prebuilt` remain experimental G2 integrations.
Their package contract must be reconciled with G1 before they establish deploy or
OTA support. Both require the exact native-owned compatibility identity as the
last argument:

```sh
pnpm --filter @hot-updater/example-lynx build:hot-updater react ios <native-runtime-id>
pnpm --filter @hot-updater/example-lynx build:prebuilt android /absolute/native-output main.lynx.bundle <native-runtime-id>
```

Use the identity from the native host's build configuration. The value is not a
framework name or app version, and packaging cannot establish compatibility by
inventing a matching label. Inputs must be compiler output without an existing
root `manifest.json` or `hot-updater-lynx.json`; repackaging an installation is
rejected. Packaging creates a fresh Bundle ID and preserves all selected files.

`app.config.ts` selects a React/Vue configuration using
`LYNX_FRAMEWORK` for the Sparkling CLI; the pinned Octane build uses its own
workspace compiler configuration.

## Isolating managed-resource loaders

Current native experiments use these additional modes:

```sh
pnpm --filter @hot-updater/example-lynx build:spike vue A normal fonts
pnpm --filter @hot-updater/example-lynx build:spike vue A normal dynamic
pnpm --filter @hot-updater/example-lynx build:spike vue A normal external2
pnpm --filter @hot-updater/example-lynx build:octane /tmp/hot-updater-octane A normal external2
```

`fonts` mounts the font probe after registration and leaves native lazy-template
loading out of that isolated test. `external2` additionally loads an independently
compiled background module through core `lynx.requireModuleAsync`. The source is
compiled by real Rspack/SWC and the official Lynx runtime-wrapper plugin. These
outputs use `A-fonts-managed/` and `A-external2-managed/` respectively; B works the
same way. The native host must record actual image/font/JS bytes and enforce
readiness after its required resource observations.

The first frozen `external` artifacts failed on both native hosts: generic
minification discarded the official runtime wrapper's evaluated return value,
which Lynx uses to obtain its initialization function. The compiler now preserves
that value by disabling minification for this standalone background module.
`external2` selects a fresh output name so those failed snapshots remain intact.
The source remains TypeScript compiled by Rspack in production mode.

`dynamic` separately compiles an app-owned native `DynamicComponent` bundle at
`dynamic/component.lynx.bundle`. All three frameworks invoke the core
`lynx.loadDynamicComponent` API and check the A/B marker written by its real
background program through Lynx shared data. This probes native template lookup,
decoding and execution. It does not mount a component from another UI framework.
The standalone compiler uses the installed official ReactLynx plugin's lazy-bundle
option, but the component source imports no React/Vue/Octane runtime.

Vue/Octane framework-generated `import()` currently fails on the tested Android
host because those runtimes do not provide `lynx.loadLazyBundle`. The core-module
experiment tests a valid app-owned background artifact; it does not establish
support for those framework-generated dynamic templates. Preserve the distinction
when reading the evidence or preparing a release.

## Public SDK bridge and update-flow probe

The public SDK entrypoints import the installed `@hot-updater/lynx`
package in both execution graphs. Background bootstrap calls `getLaunchInfo`,
waits for the required managed resources, and submits `notifyAppReady`. The UI offers
`Check update`, which downloads and verifies a prepared update, followed by
`Install next launch`. Installing does not replace this process's running bytes.

The endpoint must be explicit. For the task-owned local test service:

```sh
HOT_UPDATER_SDK_BASE_URL=http://127.0.0.1:18791/hot-updater pnpm --filter @hot-updater/example-lynx build:spike react A normal sdk3
HOT_UPDATER_SDK_BASE_URL=http://127.0.0.1:18791/hot-updater pnpm --filter @hot-updater/example-lynx build:spike vue B normal sdk3
HOT_UPDATER_SDK_BASE_URL=http://127.0.0.1:18791/hot-updater pnpm --filter @hot-updater/example-lynx build:octane /tmp/hot-updater-octane A normal sdk3
```

Raw outputs use `<framework>/<A|B>-sdk3-managed/`. Their native host must register
the public `HotUpdaterLynx` module and use the matching `ota-v2` runtime profile and
native-configured `ota-react`, `ota-vue`, or `ota-octane` channel. The earlier
private G1 host profile cannot run this public flow. Android uses the task-owned
port reverse for `18791`; the compiled artifact URLs are unchanged.

Earlier SDK1 snapshots contained only the main entry and image. Their Android
update check exposed missing `String.prototype.normalize` in the pinned PrimJS
runtime. SDK3 uses the native-owned canonical channel key supplied by `ota-v2`;
it does not add a normalization or HTTP polyfill. SDK1 and the full-resource
SDK2 snapshots remain preserved as earlier evidence.

SDK3 includes image, font, core external JS and native dynamic-component files
in the same public SDK entrypoint.
Bootstrap waits for the image, mounts the font text after registration, and
checks the actual A/B exports from core external JS and the native dynamic
component before calling public readiness. The example host must hold that
callback until its declared font has actually loaded and decoded, as well as
observing initial content. A registration callback alone cannot pass this gate.
The complete SDK3 native OTA matrix still needs execution evidence.

Public recovery probes use the existing behavior argument with `sdk3`:
`B unconfirmed`, `C unconfirmed`, or `B double-ready`. Each has a separate output
name. Unconfirmed variants complete the resource work and omit public readiness;
the duplicate-ready variant awaits two actual public callbacks. Their outputs
are preserved independently of normal SDK3. An ordinary JavaScript throw is not
evidence of a native fatal-template classification.

The shared public build wrapper produces the same complete resource tree under
`dist/<framework>`:

```sh
HOT_UPDATER_SDK_BASE_URL=http://127.0.0.1:18791/hot-updater node examples/lynx/scripts/build-public.mjs react A
HOT_UPDATER_SDK_BASE_URL=http://127.0.0.1:18791/hot-updater node examples/lynx/scripts/build-public.mjs vue A
HOT_UPDATER_SDK_BASE_URL=http://127.0.0.1:18791/hot-updater node examples/lynx/scripts/build-public.mjs octane A /tmp/hot-updater-octane
```

This wrapper explicitly selects the public SDK and full resources. Direct
compiler configuration defaults are being coordinated with native validation;
the private probe scripts continue supplying explicit G1 flags. A caller of
the exported `buildPublic` function supplies the output directory and endpoint;
the wrapper does not inject or infer native runtime identity.

`http` is a separate diagnostic mode using the proven private G1 host. It reports
the actual lexical and global `fetch`, `AbortController`, and native fetch module,
then requests `http://127.0.0.1:18791/health` before calling the native launch
probe. Its final on-screen status preserves the response or failure. These
`A-http-managed/` outputs provide no replacement globals: the SDK uses the
lexical `fetch` supplied by Lynx's background-module wrapper, which may differ
from `globalThis.fetch`.

The real HTTP diagnostic succeeded on Android React and all three iOS
frameworks: lexical `fetch` and `AbortController` were functions, while
`globalThis.fetch` was undefined. No example transport replacement was needed.
