# Builtin packaging evidence

Measured on 2026-09-20 from `examples/v0.85.0` at revision
`ec78756926cac3b23ca32c1d3acefe28d2ebb7ab`.

## Result

The target manifest can safely drive a lazy builtin lookup without embedding a
manifest in the native package. The lookup must remain partial: a missing or
different native file is a cache miss and the installer downloads that target
file.

On iOS, all 17 OTA PNG files exist below the Release `.app/assets` directory at
the same logical path with byte-identical contents. The native `main.jsbundle`
does not match the OTA Hermes file, so the first OTA downloads the bundle.

On the measured Android xxhdpi split set, 5 of the 17 OTA PNG files are present
with byte-identical contents. Twelve density variants are absent and must be
downloaded. The installed `index.android.bundle` does not match the OTA Hermes
file. The standalone optimized APK also shortens resource ZIP names, so native
lookup cannot construct APK entry paths. It must resolve the exact resource
name and requested density through `Resources`, reject a nearest-density
substitution, and hash the returned stream.

| Platform | Target files | Reusable | Missing | Mismatched |
| --- | ---: | ---: | ---: | ---: |
| iOS | 18 | 17 | 0 | 1 |
| Android xxhdpi splits | 18 | 5 | 12 | 1 |

The mismatched file on both platforms is the Hermes bundle. The native Release
bundle is produced through Re.Pack/Rspack while the configured OTA `bare`
plugin uses the React Native CLI/Metro path. Identical source therefore does
not imply identical HBC bytes. Builtin-to-first-OTA Hermes patching remains a
separate artifact registration problem, as stated in the PRD.

No font is emitted by this example, so this measurement does not claim font
coverage. A regular file exposed at the same bundle-relative path can use the
same exact-byte rule; platform resource containers that do not expose original
bytes remain unsupported misses.

## Build and comparison

Android Release artifacts:

```sh
cd examples/v0.85.0/android
./gradlew :app:bundleRelease :app:assembleRelease --build-cache
```

The AAB was converted with bundletool 1.18.1 for this device specification:

```json
{
  "supportedAbis": ["arm64-v8a"],
  "supportedLocales": ["en"],
  "screenDensity": 480,
  "sdkVersion": 35
}
```

The resulting install set contains `base-master.apk`, `base-arm64_v8a.apk`,
`base-en.apk`, and `base-xxhdpi.apk`. This avoids treating the universal APK as
evidence for files that would not be installed on a density-split device.

iOS Release artifact:

```sh
cd examples/v0.85.0/ios
xcodebuild \
  -workspace HotUpdaterExample.xcworkspace \
  -scheme HotUpdaterExample \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build-m0 \
  CODE_SIGNING_ALLOWED=NO \
  build
```

OTA outputs were built directly with the configured `bare` plugin and Hermes
enabled into `dist-m0-android` and `dist-m0-ios`. Run the comparison after
creating those outputs and the native artifacts:

```sh
python3 plans/evidence/measure_builtin_packaging.py \
  > plans/evidence/builtin-packaging.json
```

The JSON records every target logical path, target hash, package candidate
hash, split source, and classification. Generated AAB/APK/APKS, `.app`, bundle,
Pods, and Ruby artifacts are local evidence inputs and are not committed.

## Implementation constraints proven by M0

- The target manifest is sufficient to ask for only the files needed by an
  installation; a pre-embedded builtin manifest is unnecessary.
- The builtin index must be partial and regenerable. Missing density variants
  and resource-shrunk files are normal.
- Exact bytes are the only reuse criterion. App version, fingerprint, logical
  name, or nearest density cannot authorize reuse.
- iOS may read ordinary bundle-relative assets directly. Asset-catalog entries
  without original bytes are misses.
- Android must use `AssetManager` for the bundle and density-aware `Resources`
  streams for drawables. Optimized ZIP entry names are not a stable API.
- First-OTA HBC reuse is opportunistic. With the current example configuration
  it is a miss and requires a full-file descriptor.
