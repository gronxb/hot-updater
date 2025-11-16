plugins {
  kotlin("jvm") version "1.9.22"
}

repositories {
  mavenCentral()
  google()
}

// Configure source sets to include HotUpdater source code
sourceSets {
  main {
    kotlin {
      srcDir("../../../packages/react-native/android/src/main/java")
    }
  }
}

dependencies {
  // Kotlin standard library
  implementation(kotlin("stdlib"))

  // Kotlin coroutines
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")

  // OkHttp for downloads
  implementation("com.squareup.okhttp3:okhttp:4.12.0")

  // Android dependencies (provided scope for compilation)
  compileOnly("com.google.android.material:material:1.11.0")
  compileOnly("androidx.appcompat:appcompat:1.6.1")

  // JUnit 5 for testing
  testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")

  // MockK for mocking
  testImplementation("io.mockk:mockk:1.13.8")

  // Kotlin coroutines test
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
}

tasks.test {
  useJUnitPlatform()
  testLogging {
    events("passed", "skipped", "failed")
    showStandardStreams = true
  }
}

kotlin {
  jvmToolchain(17)
}
