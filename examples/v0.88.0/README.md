# React Native 0.88 example

A bare React Native 0.88 app (new architecture, CocoaPods) on Hot Updater.
The Android Integration workflow builds it, so the library keeps compiling
against the newest React Native.

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
