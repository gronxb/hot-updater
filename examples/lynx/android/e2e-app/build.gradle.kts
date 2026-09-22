import java.security.MessageDigest

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

fun embeddedDescriptor(): String {
  val manifest = file("../.hot-updater/embedded/ota/react/A/manifest.json").readBytes()
  val bundleId = Regex("\\\"bundleId\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
    .find(String(manifest))?.groupValues?.get(1)
    ?: error("Missing embedded E2E React bundleId")
  val digest = MessageDigest.getInstance("SHA-256").digest(manifest)
    .joinToString("") { "%02x".format(it) }
  return "{\\\"bundleId\\\":\\\"$bundleId\\\",\\\"manifestHash\\\":\\\"$digest\\\",\\\"minimumBundleId\\\":\\\"$bundleId\\\"}"
}

android {
  namespace = "com.hotupdater.lynxexample"
  compileSdk = 34
  buildFeatures { buildConfig = true }
  defaultConfig {
    applicationId = "com.hotupdater.lynxexample"
    minSdk = 24
    targetSdk = 34
    buildConfigField("String", "LYNX_OTA_COMPATIBILITY_ID", "\"android-sparkling-2.1.0-rc.12-navsrc-937f70d7c3012a5a-lynx-3.9.0-primjs-3.8.0-alpha.6-managed-pages-v1\"")
    buildConfigField("String", "LYNX_EMBEDDED_DESCRIPTOR", "\"${embeddedDescriptor()}\"")
    versionCode = 1
    versionName = "0.0.1"
    ndk {
      abiFilters += providers.gradleProperty("hotUpdaterLynxAndroidAbis")
        .orNull?.split(",") ?: listOf("arm64-v8a", "x86_64")
    }
  }
  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("debug")
      isDebuggable = project.findProperty("lynxE2eDebuggable") == "true"
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
  androidResources { ignoreAssetsPattern = "" }
  sourceSets.getByName("main").assets.srcDir("../.hot-updater/embedded")
}

dependencies {
  implementation(project(":hot-updater-lynx"))
  implementation(project(":hot-updater-lynx-sparkling"))
  implementation(project(":hot-updater-lynx-sparkling-diagnostics"))
  implementation("org.lynxsdk.lynx:lynx:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-jssdk:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-service-image:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-service-http:3.9.0")
  implementation("org.lynxsdk.lynx:lynx-service-log:3.9.0")
  implementation("org.lynxsdk.lynx:primjs:3.8.0-alpha.6")
  implementation("androidx.appcompat:appcompat:1.6.1")
  implementation("com.tiktok.sparkling:sparkling:2.1.0-rc.12") {
    exclude(group = "org.lynxsdk.lynx", module = "lynx-service-devtool")
    exclude(group = "org.lynxsdk.lynx", module = "lynx-devtool")
    exclude(group = "org.lynxsdk.lynx", module = "debug-router")
    exclude(group = "org.lynxsdk.lynx", module = "base-devtool")
  }
  implementation("com.tiktok.sparkling:sparkling-method:2.1.0-rc.12")
  implementation("com.facebook.fresco:fresco:3.4.0")
}
