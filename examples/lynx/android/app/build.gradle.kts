plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
  namespace = "com.hotupdater.lynxexample"
  compileSdk = 34
  defaultConfig {
    applicationId = "com.hotupdater.lynxexample"
    minSdk = 24
    targetSdk = 34
    buildConfigField("boolean", "LYNX_PROBE_SIGNING", (project.findProperty("lynxProbeSigning") == "true").toString())
    buildConfigField("String", "LYNX_OTA_COMPATIBILITY_ID", "\"android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2\"")
    versionCode = 1
    versionName = "0.0.1-g1"
    ndk { abiFilters += "arm64-v8a" }
    buildConfigField("String", "LYNX_COMPATIBILITY_ID", "\"android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-spike1\"")
  }
  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("debug")
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
  androidResources { ignoreAssetsPattern = "" }
  sourceSets.getByName("main").assets.srcDir("../.hot-updater/embedded")
}
dependencies {
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
  implementation(project(":hot-updater-lynx"))
  implementation("org.lynxsdk.lynx:lynx:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-jssdk:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-service-image:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-service-http:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-service-log:3.9.0")
  implementation("org.lynxsdk.lynx:primjs:3.8.0-alpha.6")
  implementation("androidx.appcompat:appcompat:1.6.1")
  implementation("com.squareup.okhttp3:okhttp:4.9.0")
  implementation("com.tiktok.sparkling:sparkling:2.1.0-rc.12") {
    exclude(group = "org.lynxsdk.lynx", module = "lynx-service-devtool")
    exclude(group = "org.lynxsdk.lynx", module = "lynx-devtool")
    exclude(group = "org.lynxsdk.lynx", module = "debug-router")
    exclude(group = "org.lynxsdk.lynx", module = "base-devtool")
  }
  implementation("com.tiktok.sparkling:sparkling-method:2.1.0-rc.12")
  implementation("com.facebook.fresco:fresco:2.3.0")
}
