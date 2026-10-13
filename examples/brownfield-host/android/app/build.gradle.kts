plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The E2E runner reads app-private state with `run-as`, as for the example.
val hotUpdaterE2eDebuggable = project.findProperty("HOT_UPDATER_E2E_DEBUGGABLE") == "true"

android {
    namespace = "com.hotupdaterexample"
    compileSdk = 36

    defaultConfig {
        // The example's ID and version, so every scenario runs unchanged.
        applicationId = "com.hotupdaterexample"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        getByName("debug") {
            // The example's key, so the host installs over the example.
            storeFile = file("../../../v0.85.0/android/app/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = hotUpdaterE2eDebuggable
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.hotupdaterexample:brownfieldlib:1.0.0")
}
