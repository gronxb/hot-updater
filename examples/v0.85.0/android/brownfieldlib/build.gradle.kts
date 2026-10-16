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

// E2E: the embedded bundle of the host's second Hot Updater instance,
// `widget`, from index.widget.js. Assets of every library merge into the
// app's, so it is `widget.android.bundle` beside the example's
// index.android.bundle. Built like React Native's own bundle task, for the
// same (non-debuggable) variants.
androidComponents {
    onVariants { variant ->
        val reactConfig = project.extensions.getByType(com.facebook.react.ReactExtension::class.java)
        if (reactConfig.debuggableVariants.get().any { it.equals(variant.name, ignoreCase = true) }) {
            return@onVariants
        }
        val targetName = variant.name.replaceFirstChar { it.uppercase() }
        val buildDir = layout.buildDirectory.get().asFile
        val useHermes = (findProperty("hermesEnabled")?.toString() ?: "true").toBoolean()
        val widgetBundle =
            tasks.register("createWidgetBundle${targetName}JsAndAssets", com.facebook.react.tasks.BundleHermesCTask::class.java) {
                root.set(reactConfig.root)
                nodeExecutableAndArgs.set(reactConfig.nodeExecutableAndArgs)
                cliFile.set(reactConfig.cliFile)
                bundleCommand.set(reactConfig.bundleCommand)
                entryFile.set(reactConfig.root.file("index.widget.js"))
                extraPackagerArgs.set(reactConfig.extraPackagerArgs)
                bundleAssetName.set("widget.android.bundle")
                jsBundleDir.set(File(buildDir, "generated/assets/widget/${variant.name}"))
                resourcesDir.set(File(buildDir, "generated/res/widget/${variant.name}"))
                hermesEnabled.set(useHermes)
                minifyEnabled.set(!useHermes)
                devEnabled.set(false)
                jsIntermediateSourceMapsDir.set(File(buildDir, "intermediates/sourcemaps/widget/${variant.name}"))
                jsSourceMapsDir.set(File(buildDir, "generated/sourcemaps/widget/${variant.name}"))
                hermesCommand.set(reactConfig.hermesCommand)
                hermesFlags.set(reactConfig.hermesFlags)
                reactNativeDir.set(reactConfig.reactNativeDir)
                // The example's bundle comes from :app, as React Native
                // Brownfield packages it. Both bundlers write the example's
                // generated build config (src/e2eBuildConfig.js), so they never
                // run at once, even in a parallel build.
                rootProject.findProject(":app")?.let { app ->
                    mustRunAfter(app.tasks.matching { it.name == "createBundle${targetName}JsAndAssets" })
                }
            }
        variant.sources.assets?.addGeneratedSourceDirectory(
            widgetBundle,
            com.facebook.react.tasks.BundleHermesCTask::jsBundleDir,
        )
        variant.sources.res?.addGeneratedSourceDirectory(
            widgetBundle,
            com.facebook.react.tasks.BundleHermesCTask::resourcesDir,
        )
    }
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
