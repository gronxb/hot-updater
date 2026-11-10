import UIKit

import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import HotUpdater

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = OneDependencyProvider()
    reactNativeDelegate = delegate
    reactNativeFactory = factory
    return true
  }
}

// react native creates these modules on the main queue while the instance
// initializes. left lazy, the first js access blocks the js thread on a
// synchronous main queue hop that waits behind the app's own launch work.
class OneDependencyProvider: RCTAppDependencyProvider {
  override func unstableModulesRequiringMainQueueSetup() -> [String] {
    super.unstableModulesRequiringMainQueueSetup() + [
      "PlatformConstants",
      "DeviceInfo",
      "AccessibilityManager",
      "Appearance",
      "OneNativeSafeAreaContext",
    ]
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  // [vxrn/one] the launch screen stays over the root until react native's first content
  override func customize(_ rootView: RCTRootView) {
    super.customize(rootView)
    OneHoldLaunchScreen(rootView)
  }

  override func bundleURL() -> URL? {
#if DEBUG
    guard let bundleURL = RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index") else { return nil }
    if bundleURL.isFileURL { return bundleURL }
    var components = URLComponents(url: bundleURL, resolvingAgainstBaseURL: false)!
    components.queryItems!.append(URLQueryItem(name: "bytecode", value: "hermes"))
    return components.url
#else
    HotUpdater.bundleURL()
#endif
  }
}
