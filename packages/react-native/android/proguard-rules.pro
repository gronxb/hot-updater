# Old Architecture
# Invoked via reflection, when setting js bundle.
-keepclassmembers class com.facebook.react.ReactInstanceManager {
    private final ** mBundleLoader;
}

# New Architecture
# Keep fields accessed via reflection in ReactHost
# Support both Java (mReactHostDelegate) and Kotlin (reactHostDelegate) field names
-keepclassmembers class com.facebook.react.runtime.ReactHostImpl {
    private final ** mReactHostDelegate;
    private final ** reactHostDelegate;
}

-keepclassmembers class * implements com.facebook.react.runtime.ReactHostDelegate {
    ** jsBundleLoader;
}

# Preserve the Brotli decoder and its embedded static dictionary
# (DictionaryData). R8 otherwise strips the dictionary's static init, causing OTA
# .tar.br extraction to fail at runtime with:
#   java.io.IOException: Brotli stream decoding failed
#   Caused by: brotli dictionary is not set
-keep class com.hotupdater.vendor.brotli.** { *; }
