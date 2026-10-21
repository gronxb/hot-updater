# React Native 0.88 example

A bare React Native 0.88 app (new architecture, CocoaPods, Metro) on Hot
Updater. The Android Integration workflow builds it, so the library keeps
compiling against the newest React Native, and it is an E2E target
(`pnpm -w e2e -- --target v0.88.0`, see
[targets](../../e2e/README.md#targets)): it runs the shared
[`@examples/e2e-app`](../e2e-app).

## Run

```sh
pnpm install
pnpm --filter @hot-updater/react-native build
cd ios && bundle install && bundle exec pod install && cd ..
pnpm ios     # or: pnpm android
```

## Deploy

Fill in `.env.hotupdater` (see `hot-updater.config.ts`), then:

```sh
pnpm hot-updater deploy -p android
```
