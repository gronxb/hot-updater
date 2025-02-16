# Old Architecture
# Invoked via reflection, when setting js bundle.
-keepclassmembers class com.facebook.react.ReactInstanceManager {
    private final ** mBundleLoader;
}

# New Architecture
# Keep fields accessed via reflection in ReactHost
-keepclassmembers class com.facebook.react.runtime.ReactHostImpl {
    private final ** mReactHostDelegate;
}

-keepclassmembers class * implements com.facebook.react.runtime.ReactHostDelegate {
    ** jsBundleLoader;
}