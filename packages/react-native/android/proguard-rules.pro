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
    private val reactHostDelegate: **;
}

-keepclassmembers class * implements com.facebook.react.runtime.ReactHostDelegate {
    ** jsBundleLoader;
}