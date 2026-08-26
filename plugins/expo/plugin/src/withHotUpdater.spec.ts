import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { transformAndroid, transformIOS } from "./transformers";
import { getPublicKeyFromConfig } from "./withHotUpdater";

const tempDirs: string[] = [];

const createKeyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("getPublicKeyFromConfig", () => {
  it("returns null when signing is omitted", async () => {
    await expect(getPublicKeyFromConfig(undefined)).resolves.toBeNull();
  });

  it("uses publicKeyPath without accessing the signing provider", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-public-key-"));
    tempDirs.push(dir);
    const { publicKey } = createKeyPair();
    const publicKeyPath = path.join(dir, "public-key.pem");
    const provider = {
      getPublicKey: vi.fn(),
      name: "remoteSigner",
      publicKeyPath,
      sign: vi.fn(),
    };

    await writeFile(publicKeyPath, publicKey);

    await expect(getPublicKeyFromConfig(provider)).resolves.toBe(
      publicKey.trim(),
    );
    expect(provider.getPublicKey).not.toHaveBeenCalled();
    expect(provider.sign).not.toHaveBeenCalled();
  });

  it("rejects an invalid publicKeyPath without accessing the signer", async () => {
    const provider = {
      getPublicKey: vi.fn(),
      name: "remoteSigner",
      publicKeyPath: "/missing/provider-public-key.pem",
      sign: vi.fn(),
    };

    await expect(getPublicKeyFromConfig(provider)).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
    expect(provider.getPublicKey).not.toHaveBeenCalled();
    expect(provider.sign).not.toHaveBeenCalled();
  });

  it("rejects an empty publicKeyPath", async () => {
    const provider = {
      getPublicKey: vi.fn(),
      name: "remoteSigner",
      publicKeyPath: "",
      sign: vi.fn(),
    };

    await expect(getPublicKeyFromConfig(provider)).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
    expect(provider.getPublicKey).not.toHaveBeenCalled();
    expect(provider.sign).not.toHaveBeenCalled();
  });

  it("rejects a private PEM passed as publicKeyPath", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-public-key-"));
    tempDirs.push(dir);
    const { privateKey } = createKeyPair();
    const publicKeyPath = path.join(dir, "public-key.pem");
    const provider = {
      getPublicKey: vi.fn(),
      name: "remoteSigner",
      publicKeyPath,
      sign: vi.fn(),
    };
    await writeFile(publicKeyPath, privateKey);

    await expect(getPublicKeyFromConfig(provider)).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
    expect(provider.getPublicKey).not.toHaveBeenCalled();
    expect(provider.sign).not.toHaveBeenCalled();
  });

  it("rejects an RSA public key weaker than 2048 bits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-public-key-"));
    tempDirs.push(dir);
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const publicKeyPath = path.join(dir, "public-key.pem");
    const provider = {
      getPublicKey: vi.fn(),
      name: "remoteSigner",
      publicKeyPath,
      sign: vi.fn(),
    };
    await writeFile(publicKeyPath, publicKey);

    await expect(getPublicKeyFromConfig(provider)).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
    expect(provider.getPublicKey).not.toHaveBeenCalled();
  });
});

describe("withHotUpdater - Test Cases", () => {
  describe("Android", () => {
    it("RN 0.82+ Kotlin: input -> output", () => {
      // Input: Raw RN 0.82 template
      const _input = `package com.rndiffapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        }
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}`;

      // Expected Output: With HotUpdater import and jsBundleFilePath injected
      const _expected = `package com.rndiffapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      jsBundleFilePath = if (BuildConfig.DEBUG) {
        null
      } else {
        HotUpdater.getJSBundleFile(applicationContext)
      },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}`;

      const result = transformAndroid(_input);
      expect(result).toBe(_expected);
    });

    it("RN 0.82+ Kotlin: migrates the previous HotUpdater bundle path", () => {
      const input = `package com.rndiffapp

import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = emptyList(),
      jsBundleFilePath = HotUpdater.getJSBundleFile(applicationContext),
    )
  }
}`;

      const expected = `package com.rndiffapp

import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = emptyList(),
      jsBundleFilePath = if (BuildConfig.DEBUG) {
        null
      } else {
        HotUpdater.getJSBundleFile(applicationContext)
      },
    )
  }
}`;

      const result = transformAndroid(input);
      expect(result).toBe(expected);
      expect(transformAndroid(result)).toBe(result);
    });

    it("RN 0.82+ Kotlin: keeps a custom bundle path", () => {
      const input = `package com.rndiffapp

import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = emptyList(),
      jsBundleFilePath = customBundlePath,
    )
  }
}`;

      expect(transformAndroid(input)).toBe(input);
    });

    it("RN 0.81 Kotlin: input -> output", () => {
      // Input: RN 0.81 template with old pattern
      const _input = `package com.hotupdaterexample

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}`;

      // Expected Output: With getJSBundleFile() override added
      const _expected = `package com.hotupdaterexample

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

        override fun getJSBundleFile(): String? {
          return if (BuildConfig.DEBUG) {
            null
          } else {
            HotUpdater.getJSBundleFile(applicationContext)
          }
        }
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}`;

      const result = transformAndroid(_input);
      expect(result).toBe(_expected);
    });

    it("RN 0.81 Kotlin: migrates the previous HotUpdater bundle path", () => {
      const input = `package com.hotupdaterexample

import com.facebook.react.ReactApplication
import com.facebook.react.defaults.DefaultReactNativeHost
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

      override fun getJSBundleFile(): String? {
        return HotUpdater.getJSBundleFile(applicationContext)
      }
    }
}`;

      const expected = `package com.hotupdaterexample

import com.facebook.react.ReactApplication
import com.facebook.react.defaults.DefaultReactNativeHost
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

      override fun getJSBundleFile(): String? {
        return if (BuildConfig.DEBUG) {
          null
        } else {
          HotUpdater.getJSBundleFile(applicationContext)
        }
      }
    }
}`;

      const result = transformAndroid(input);
      expect(result).toBe(expected);
      expect(transformAndroid(result)).toBe(result);
    });

    it("Expo 54 Kotlin: input -> output", () => {
      // Input: Expo 54 template
      const _input = `package com.gronxb.expo54

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}`;

      // Expected Output: With HotUpdater import and getJSBundleFile() override added
      const _expected = `package com.gronxb.expo54

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED

          override fun getJSBundleFile(): String? {
              return if (BuildConfig.DEBUG) {
                null
              } else {
                HotUpdater.getJSBundleFile(applicationContext)
              }
          }
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}`;

      const result = transformAndroid(_input);
      expect(result).toBe(_expected);
    });

    it("Expo 55 Kotlin: adds jsBundleFilePath with missing trailing comma", () => {
      const _input = `package com.gronxb.expo55

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        }
    )
  }
}`;

      const _expected = `package com.gronxb.expo55

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater
import com.facebook.react.ReactHost
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      jsBundleFilePath = if (BuildConfig.DEBUG) {
        null
      } else {
        HotUpdater.getJSBundleFile(applicationContext)
      },
    )
  }
}`;

      const result = transformAndroid(_input);
      expect(result).toBe(_expected);
    });

    it("Android Kotlin: inserts inside getDefaultReactHost closed with ),", () => {
      const _input = `package com.gronxb.reacthost

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import expo.modules.ExpoReactHostFactory
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ReactNativeHostWrapper.createReactHost(
      context = applicationContext,
      reactHost = ExpoReactHostFactory.getDefaultReactHost(
        context = applicationContext,
        packageList =
          PackageList(this).packages.apply {
            // add(MyReactNativePackage())
          }
      ),
    )
  }
}`;

      const _expected = `package com.gronxb.reacthost

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.hotupdater.HotUpdater
import com.facebook.react.ReactHost
import expo.modules.ExpoReactHostFactory
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ReactNativeHostWrapper.createReactHost(
      context = applicationContext,
      reactHost = ExpoReactHostFactory.getDefaultReactHost(
        context = applicationContext,
        packageList =
          PackageList(this).packages.apply {
            // add(MyReactNativePackage())
          },
        jsBundleFilePath = if (BuildConfig.DEBUG) {
          null
        } else {
          HotUpdater.getJSBundleFile(applicationContext)
        },
      ),
    )
  }
}`;

      const result = transformAndroid(_input);
      expect(result).toBe(_expected);
    });
  });

  describe("iOS", () => {
    it("Objective-C AppDelegate.mm: input -> output", () => {
      // Input: Objective-C AppDelegate template
      const _input = `#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"HotUpdaterExample";
  self.initialProps = @{};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end`;

      // Expected Output: With HotUpdater import and bundleURL replacement
      const _expected = `#import "AppDelegate.h"
#import <HotUpdater/HotUpdater.h>
#import <React/RCTBundleURLProvider.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"HotUpdaterExample";
  self.initialProps = @{};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [HotUpdater bundleURL];
#endif
}

@end`;

      const result = transformIOS(_input);
      expect(result).toBe(_expected);
    });

    it("Swift AppDelegate: input -> output", () => {
      // Input: Swift AppDelegate template
      const _input = `import UIKit
import React

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let bridge = RCTBridge(delegate: self, launchOptions: launchOptions)
    let rootView = RCTRootView(bridge: bridge!, moduleName: "main", initialProperties: nil)

    window = UIWindow(frame: UIScreen.main.bounds)
    let rootViewController = UIViewController()
    rootViewController.view = rootView
    window?.rootViewController = rootViewController
    window?.makeKeyAndVisible()

    return true
  }

  func sourceURL(for bridge: RCTBridge) -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}`;

      // Expected Output: With HotUpdater import and bundleURL replacement
      const _expected = `import UIKit
import React
import HotUpdater

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let bridge = RCTBridge(delegate: self, launchOptions: launchOptions)
    let rootView = RCTRootView(bridge: bridge!, moduleName: "main", initialProperties: nil)

    window = UIWindow(frame: UIScreen.main.bounds)
    let rootViewController = UIViewController()
    rootViewController.view = rootView
    window?.rootViewController = rootViewController
    window?.makeKeyAndVisible()

    return true
  }

  func sourceURL(for bridge: RCTBridge) -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    return HotUpdater.bundleURL()
#endif
  }
}`;

      const result = transformIOS(_input);
      expect(result).toBe(_expected);
    });

    it("Expo 54 Swift: input -> output", () => {
      // Input: Expo 54 Swift template
      const _input = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}`;

      // Expected Output: With HotUpdater import and bundleURL replacement
      const _expected = `import Expo
import React
import ReactAppDependencyProvider
import HotUpdater

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return HotUpdater.bundleURL()
#endif
  }
}`;

      const result = transformIOS(_input);
      expect(result).toBe(_expected);
    });
  });
});
