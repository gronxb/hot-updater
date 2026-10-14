plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.callstack.react.brownfield")
    `maven-publish`
    id("com.facebook.react")
}

react {
    autolinkLibrariesWithApp()
}

repositories {
    mavenCentral()
}

android {
    namespace = "com.rnbrownfieldreact"
    compileSdk = 36

    defaultConfig {
        minSdk = 24

        buildConfigField("boolean", "IS_EDGE_TO_EDGE_ENABLED", properties["edgeToEdgeEnabled"].toString())
        buildConfigField("boolean", "IS_NEW_ARCHITECTURE_ENABLED", properties["newArchEnabled"].toString())
        buildConfigField("boolean", "IS_HERMES_ENABLED", properties["hermesEnabled"].toString())
    }

    publishing {
        multipleVariants {
            allVariants()
        }
    }
}

publishing {
    publications {
        create<MavenPublication>("mavenAar") {
            groupId = "com.rnbrownfieldreact"
            artifactId = "rnbrownfield"
            version = "0.0.1-local"
            afterEvaluate {
                from(components.getByName("default"))
            }

            pom {
                withXml {
                    /**
                     * As a result of `from(components.getByName("default")` all of the project
                     * dependencies are added to `pom.xml` file. We do not need the react-native
                     * third party dependencies to be a part of it as we embed those dependencies.
                     */
                    val dependenciesNode = (asNode().get("dependencies") as groovy.util.NodeList).first() as groovy.util.Node
                    dependenciesNode.children()
                        .filterIsInstance<groovy.util.Node>()
                        .filter { (it.get("groupId") as groovy.util.NodeList).text() == rootProject.name }
                        .forEach { dependenciesNode.remove(it) }
                }
            }
        }
    }

    repositories {
        mavenLocal() // Publishes to the local Maven repository (~/.m2/repository)
    }
}

// The brownfield plugin adds ../app/build/generated/{assets,res}/react/<variant>
// to this module's source sets, but Gradle does not treat those directories as
// task inputs. After the first build, a changed JS bundle leaves the asset and
// resource merges UP-TO-DATE and the AAR ships the previous bundle. Removing
// their outputs before they run forces a full merge on every `package:aar`.
val dropMergedReactSources by tasks.registering(Delete::class) {
    delete(layout.buildDirectory.dir("intermediates/assets"))
    delete(layout.buildDirectory.dir("intermediates/packaged_res"))
}
tasks.matching { Regex("(merge\\w+Assets|package\\w+Resources)").matches(it.name) }.configureEach {
    dependsOn(dropMergedReactSources)
}

dependencies {
    api("com.facebook.react:react-android:0.86.0")
    api("com.facebook.hermes:hermes-android:250829098.0.14")
}
