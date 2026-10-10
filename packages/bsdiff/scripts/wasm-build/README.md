# Rebuilding the WASM asset

Normal package builds use the checked-in `assets/hdiff.wasm`. They do not
recompile it with the machine's Rust toolchain, which can change its bytes and
invalidate source and artifact attestations.

After changing the Rust implementation, run:

```sh
pnpm --filter @hot-updater/bsdiff build:wasm
pnpm --filter @hot-updater/bsdiff build
pnpm --filter @hot-updater/bsdiff test
```

Review and commit the regenerated asset with its source changes. The rebuild
command requires Cargo, rustup, and the `wasm32-unknown-unknown` target; it installs
the target if needed. When Rust tools are absent, the command reports that it
keeps the existing precompiled asset.
