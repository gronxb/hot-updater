---
"@hot-updater/lynx": patch
"@hot-updater/lynx-sparkling": patch
---

Align the Android Java and Kotlin targets at JVM 17 so Lynx libraries compile
in applications that also use React Native's Java 17 toolchain alignment.
Keep Sparkling's dependency graph verification independent of the host project's
name and Gradle's detached-configuration root label, preserving the pinned graph
and upstream artifact hashes.
