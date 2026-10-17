// Packages the example as an AAR for the brownfield E2E track, as React
// Native Brownfield's scaffold does (see the brownfield guide).
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.callstack.react.brownfield")
    `maven-publish`
    id("com.facebook.react")
}

fun rootInt(name: String): Int = rootProject.extensions.extraProperties.get(name).toString().toInt()

publishing {
    publications {
        create<MavenPublication>("mavenAar") {
            groupId = "com.hotupdaterexample"
            artifactId = "brownfieldlib"
            version = "1.0.0"
            afterEvaluate {
                from(components.getByName("default"))
            }
        }
    }
    repositories {
        // A repository inside this build, so concurrent runs never share one.
        maven {
            name = "brownfieldE2e"
            url = uri(layout.buildDirectory.dir("maven"))
        }
    }
}

reactBrownfield {
    missingDimensionStrategies = listOf()
}

react {
    autolinkLibrariesWithApp()
}

android {
    namespace = "com.hotupdaterexample.brownfield"
    compileSdk = rootInt("compileSdkVersion")

    defaultConfig {
        minSdk = rootInt("minSdkVersion")
        consumerProguardFiles("consumer-rules.pro")
        // Read by React Native's generated entry point, as in an app module.
        buildConfigField("boolean", "IS_NEW_ARCHITECTURE_ENABLED", properties["newArchEnabled"].toString())
        buildConfigField("boolean", "IS_HERMES_ENABLED", properties["hermesEnabled"].toString())
        buildConfigField("boolean", "IS_EDGE_TO_EDGE_ENABLED", properties["edgeToEdgeEnabled"].toString())
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    publishing {
        multipleVariants {
            allVariants()
        }
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    api("com.facebook.react:react-android:0.85.2")
    api("com.facebook.hermes:hermes-android:250829098.0.10")
}
