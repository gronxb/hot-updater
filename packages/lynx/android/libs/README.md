# Lynx-private Brotli decoder

This is the repository's security-fixed Google Brotli 1.2.0 decoder, adapted
from `packages/react-native/android/libs/hot-updater-brotli-dec-1.2.0.jar`.
The RN input remains byte-for-byte unchanged. Its source and license provenance
is Google Brotli commit `028fb5a23661f123017c060daa546b55cf4bde29` (v1.2.0).
The original upstream artifact SHA-256 is
`2d12a2d7fb52fd7f944564fb378aaccd41389cf02ea2e5eb6b3a6477188cced8`.

The existing RN relocation's input SHA-256 is
`4e9aee81466e21e365fd291bd29ca0540dc174ce64d29a7613ff336e4276bcdf`.
Lynx relocates its actual JVM bytecode again to
`com.hotupdater.lynx.vendor.brotli.dec`, preventing class collisions when an
application includes both integrations. The two JAR class inventories were
compared and have no intersection.

Reproduction uses `org.pantsbuild:jarjar:1.7.2`, with `org.ow2.asm:asm:9.7.1`
and `org.ow2.asm:asm-commons:9.7.1` on its Java classpath:

```sh
printf 'rule com.hotupdater.vendor.brotli.** com.hotupdater.lynx.vendor.brotli.@1\n' > /tmp/lynx-brotli.rules
java -cp "$JARJAR_CLASSPATH" org.pantsbuild.jarjar.Main process \
  /tmp/lynx-brotli.rules \
  packages/react-native/android/libs/hot-updater-brotli-dec-1.2.0.jar \
  packages/lynx/android/libs/hot-updater-brotli-dec-1.2.0.jar
```

Result SHA-256:
`3ddbb1a4c66cf57a879873f1238b62b8ba0ba9bf0ff545452402dbb92ca893e2`.
No production signing key or native binary is part of this decoder JAR.
