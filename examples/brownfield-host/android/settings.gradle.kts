pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // The AAR that examples/v0.85.0 packages (`:brownfieldlib` publishes
        // it inside its own build directory).
        maven { url = uri("../../v0.85.0/android/brownfieldlib/build/maven") }
        google()
        mavenCentral()
    }
}
rootProject.name = "HotUpdaterExampleBrownfieldHost"
include(":app")
