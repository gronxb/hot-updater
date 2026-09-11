pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "HotUpdaterLynxSpike"
include(":app")
val lynxPackage = providers.exec {
    workingDir(settingsDir.parentFile)
    commandLine("node", "--print", "require.resolve('@hot-updater/lynx/package.json')")
}.standardOutput.asText.get().trim()
include(":hot-updater-lynx")
project(":hot-updater-lynx").projectDir = File(File(lynxPackage).parentFile, "android")
