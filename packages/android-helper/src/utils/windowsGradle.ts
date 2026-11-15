import fs from "fs";
import os from "os";
import path from "path";

/**
 * The init script every Windows build runs with. ninja 1.10.2, which the
 * Android SDK's CMake 3.22.1 ships, can't reach a path over MAX_PATH (260
 * characters), and React Native's codegen object paths, which repeat the
 * project's path, pass it. At 259, CMake hashes the long part of an object's
 * name so the whole path stays within it; at 250, an object directory of
 * 179 characters left no room for the hash and a 40-character file name.
 * Only the names of objects under `.cxx` change, never what they compile
 * to.
 *
 * Expo's root project plugin (expo-modules-autolinking 58,
 * `ExpoRootProjectPlugin.kt` `setDefaultCmakeObjectPathMax`) gives every
 * module `-DCMAKE_OBJECT_PATH_MAX` from the `expo.android.cmakeObjectPathMax`
 * property, 1024 when unset, which it reads with `findProperty` as a string
 * when it applies. So the script sets that property on the root project
 * first, unless gradle.properties, the user's, `-P` or the environment set
 * it. A module whose own CMake arguments set CMAKE_OBJECT_PATH_MAX, in its
 * default config, a build type or a flavor, keeps its own.
 */
export const WINDOWS_INIT_SCRIPT = `// Written by hot-updater for one Windows build: object paths within MAX_PATH.
gradle.rootProject { root ->
  if (!root.hasProperty('expo.android.cmakeObjectPathMax')) {
    root.ext.set('expo.android.cmakeObjectPathMax', '259')
  }
}
allprojects { project ->
  ['com.android.application', 'com.android.library'].each { id ->
    project.plugins.withId(id) {
      project.extensions.getByName('androidComponents').finalizeDsl { android ->
        def configs = [android.defaultConfig] + android.buildTypes.toList() + android.productFlavors.toList()
        def own = configs.any { config ->
          config.externalNativeBuild.cmake.arguments.any { it.startsWith('-DCMAKE_OBJECT_PATH_MAX') }
        }
        if (!own) {
          android.defaultConfig.externalNativeBuild.cmake.arguments.add('-DCMAKE_OBJECT_PATH_MAX=259')
        }
      }
    }
  }
}
`;
/**
 * Runs `build` with the Gradle arguments a Windows build needs: none
 * elsewhere. The init script is written outside the project, and removed
 * after.
 */
export const withWindowsGradleArgs = async <T>(
  build: (args: string[]) => Promise<T>,
): Promise<T> => {
  if (!process.platform.startsWith("win")) return build([]);
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-windows-"),
  );
  try {
    const script = path.join(directory, "windows.init.gradle");
    await fs.promises.writeFile(script, WINDOWS_INIT_SCRIPT);
    return await build(["--init-script", script]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
