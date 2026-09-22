import java.security.MessageDigest
import java.net.URI

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val productionManifest =
  file("../.hot-updater/production-embedded/ota/react/A/manifest.json")
val productionAppBaseUrl = providers.gradleProperty("hotUpdaterAppBaseUrl")
  .orElse(providers.environmentVariable("HOT_UPDATER_APP_BASE_URL"))
  .orNull.orEmpty()
if (productionAppBaseUrl.isNotEmpty()) {
  require(productionAppBaseUrl == productionAppBaseUrl.trim()) {
    "HOT_UPDATER_APP_BASE_URL must not contain whitespace"
  }
  val uri = URI(productionAppBaseUrl)
  val host = uri.host?.lowercase().orEmpty()
  require(
    uri.scheme == "https" && host.isNotEmpty() && uri.userInfo == null &&
      uri.fragment == null && host != "localhost" && host != "0.0.0.0" &&
      !host.startsWith("127.") && host != "::1" && host != "[::1]" &&
      !listOf(".localhost", ".local", ".test", ".example", ".invalid")
        .any(host::endsWith)
  ) {
    "HOT_UPDATER_APP_BASE_URL must be a nonlocal HTTPS URL without credentials or a fragment"
  }
}
val escapedProductionAppBaseUrl = productionAppBaseUrl
  .replace("\\", "\\\\").replace("\"", "\\\"")

fun embeddedDescriptor(): String {
  if (!productionManifest.isFile) {
    return "{\\\"bundleId\\\":\\\"missing\\\",\\\"manifestHash\\\":\\\"missing\\\",\\\"minimumBundleId\\\":\\\"missing\\\"}"
  }
  val manifest = productionManifest.readBytes()
  val bundleId = Regex("\\\"bundleId\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
    .find(String(manifest))?.groupValues?.get(1)
    ?: error("Missing embedded React bundleId")
  val digest = MessageDigest.getInstance("SHA-256").digest(manifest)
    .joinToString("") { "%02x".format(it) }
  return "{\\\"bundleId\\\":\\\"$bundleId\\\",\\\"manifestHash\\\":\\\"$digest\\\",\\\"minimumBundleId\\\":\\\"$bundleId\\\"}"
}

val verifyProductionEmbedded by tasks.registering {
  inputs.file(productionManifest)
  doLast {
    check(productionManifest.isFile) {
      "Generate the production React embedded release before assembling :app"
    }
  }
}

val verifyProductionNetworkPolicy by tasks.registering {
  dependsOn("processReleaseMainManifest", "packageReleaseResources")
  doLast {
    val mergedManifests = fileTree(
      layout.buildDirectory.dir("intermediates/merged_manifests/release"),
    ) { include("**/AndroidManifest.xml") }.files
    check(mergedManifests.isNotEmpty()) {
      "Release merged manifest was not produced"
    }
    mergedManifests.forEach { manifest ->
      val text = manifest.readText()
      check("usesCleartextTraffic" !in text) {
        "Production Release enables cleartext traffic"
      }
      check("networkSecurityConfig" !in text) {
        "Production Release includes a test network security policy"
      }
    }
    val packagedPolicies = fileTree(
      layout.buildDirectory.dir("intermediates/packaged_res/release"),
    ) { include("**/lynx_network_security_config.xml") }.files
    check(packagedPolicies.isEmpty()) {
      "Production Release packages a test network security policy"
    }
  }
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
    buildConfigField("String", "HOT_UPDATER_APP_BASE_URL", "\"$escapedProductionAppBaseUrl\"")
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
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
  androidResources { ignoreAssetsPattern = "" }
  sourceSets.getByName("main").assets.srcDir("../.hot-updater/production-embedded")
}
dependencies {
  implementation(project(":hot-updater-lynx"))
  implementation(project(":hot-updater-lynx-sparkling"))
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

tasks.named("preBuild").configure { dependsOn(verifyProductionEmbedded) }
tasks.configureEach {
  if (name == "assembleRelease") {
    dependsOn(verifyProductionNetworkPolicy)
  }
}
