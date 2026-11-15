import fs from "fs";
import os from "os";
import path from "path";

/**
 * The init script every Windows build runs with. ninja 1.10.2, which the
 * Android SDK's CMake 3.22.1 ships, can't reach a path over MAX_PATH (260
 * characters), and React Native's codegen object paths, which repeat the
 * project's path, pass it. At 250, CMake's own default on Windows, CMake
 * hashes the long part of an object's name. Only the names of objects
 * under `.cxx` change, never what they compile to.
 */
export const WINDOWS_INIT_SCRIPT = `// Written by hot-updater for one Windows build: object paths within MAX_PATH.
allprojects { project ->
  ['com.android.application', 'com.android.library'].each { id ->
    project.plugins.withId(id) {
      project.extensions.getByName('androidComponents').finalizeDsl { android ->
        android.defaultConfig.externalNativeBuild.cmake.arguments.add('-DCMAKE_OBJECT_PATH_MAX=250')
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
