# Old Architecture
# Invoked via reflection, when setting js bundle.
-keepclassmembers class com.facebook.react.ReactInstanceManager {
    private final ** mBundleLoader;
    private final ** mJSExceptionHandler;
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
    ** exceptionHandler;
}

-keepclassmembers class com.facebook.react.bridge.CatalystInstanceImpl {
    ** mJSExceptionHandler;
}

# A runtime's host, read by reflection to hook a named instance's JavaScript
# errors: Kotlin (reactHost) and Java before React Native 0.80 (mReactHost)
-keepclassmembers class com.facebook.react.runtime.BridgelessReactContext {
    ** reactHost;
    ** mReactHost;
}

# The root view tag counter, looked up by class name and read by reflection
# to tell which runtime shows a screen: Kotlin object (nextRootViewTag) and
# Java static before React Native 0.80 (sNextRootViewTag)
-keep class com.facebook.react.uimanager.ReactRootViewTagGenerator {
    int nextRootViewTag;
    int sNextRootViewTag;
}

# Preserve the Brotli decoder and its embedded static dictionary
# (DictionaryData). R8 otherwise strips the dictionary's static init, causing
# per-file Brotli decompression to fail at runtime with:
#   java.io.IOException: Brotli stream decoding failed
#   Caused by: brotli dictionary is not set
-keep class com.hotupdater.vendor.brotli.** { *; }
