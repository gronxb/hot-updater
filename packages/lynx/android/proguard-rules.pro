# Brotli loads DictionaryData reflectively from Dictionary's package name.
# Preserve its name and static initialization in consuming apps' R8 builds.
-keep class com.hotupdater.lynx.vendor.brotli.** { *; }
