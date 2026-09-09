# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:
-keep class com.wix.detox.** { *; }

# The separate Detox test APK reads this field from the minified app APK.
-keep class com.hotupdaterexample.BuildConfig {
    public static final boolean DEBUG;
}

# Detox's separate test APK uses these members from the app's shared dependency.
-keep class org.apache.commons.lang3.ArrayUtils {
    public static final java.lang.Class[] EMPTY_CLASS_ARRAY;
    public static java.lang.Class[] nullToEmpty(java.lang.Class[]);
    public static java.lang.Object[] nullToEmpty(java.lang.Object[]);
}
-keep class org.apache.commons.lang3.StringUtils {
    public static boolean isBlank(java.lang.CharSequence);
}
-keep class org.apache.commons.lang3.reflect.MethodUtils {
    public <init>();
    public static java.lang.reflect.Method getAccessibleMethod(java.lang.Class, java.lang.String, java.lang.Class[]);
    public static java.lang.Object invokeExactMethod(java.lang.Object, java.lang.String, java.lang.Object[]);
    public static java.lang.Object invokeMethod(java.lang.Object, java.lang.String, java.lang.Object[]);
    public static java.lang.Object invokeStaticMethod(java.lang.Class, java.lang.String, java.lang.Object[]);
}

# Keep shared Kotlin APIs referenced only by the separate test APK.
-keep @interface kotlin.Metadata { *; }
-keep class kotlin.Result {
    public static boolean isSuccess-impl(java.lang.Object);
}
-keep class kotlin.TypeCastException {
    public <init>(java.lang.String);
}
-keep class kotlin.coroutines.ContinuationKt {
    public static kotlin.coroutines.Continuation createCoroutine(kotlin.jvm.functions.Function1, kotlin.coroutines.Continuation);
}
-keep class kotlin.time.DurationKt {
    public static long toDuration(int, kotlin.time.DurationUnit);
}
