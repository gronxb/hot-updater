# Lynx image service with Fresco 3

The published `org.lynxsdk.lynx:lynx-service-image:3.9.0` AAR calls Fresco 2
classes. Fresco 3.4.0 provides 16 KB-aligned native libraries but changes
`CloseableBitmap` and `CloseableImage` to interfaces. Using that AAR with Fresco
3 therefore throws `IncompatibleClassChangeError` when decoding a bitmap.

`fresco-compat.gradle` compiles the five Java files in the upstream 3.9.0 sources
JAR against Fresco 3.4.0. It verifies SHA-256
`41f9087ff78a4cb29c0322c9c41e45c1e491ef85f58d4f233b1136fbb0a0b68a` before
extracting them. Compilation fixes the class/interface invocation ABI.

The only source adaptations are the three animation-listener callback argument
types (`AnimatedDrawable2` to `Drawable`) and the two corresponding `isRunning`
casts. These callbacks are registered on an `AnimatedDrawable2`, so ownership,
loop reporting, and release behavior remain those of the upstream service.
Generated sources stay in the build directory. The upstream Apache 2.0 license
is retained beside this file.

Apps must exclude the upstream image-service AAR from their Sparkling dependency
to avoid duplicate classes. Fresco and its animation dependencies are supplied
by the optional Hot Updater Sparkling integration. Application initialization
uses the normal Sparkling pool configuration without changing the allocator.

This temporary adaptation is specific to Fresco. It does not enable Android
page-size compatibility mode or legacy JNI compression. Remove it when an
upstream image-service binary is verified against a compatible Fresco release.
