import HotUpdater
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  /// One React Native instance for the app: the scene's root view and a
  /// background launch's headless one share it.
  lazy var reactNativeFactory: RCTReactNativeFactory = {
    let delegate = ReactNativeDelegate()
    delegate.dependencyProvider = RCTAppDependencyProvider()
    reactNativeDelegate = delegate
    return RCTReactNativeFactory(delegate: delegate)
  }()

  private var reactNativeDelegate: ReactNativeDelegate?
  private var headlessRootView: UIView?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // E2E: a silent push launches the app in the background, and no scene
    // connects. Like React Native Firebase, start React Native without a
    // window and tell the root, so it renders nothing for that launch.
    if application.applicationState == .background {
      headlessRootView = reactNativeFactory.rootViewFactory.view(
        withModuleName: "HotUpdaterExample",
        initialProperties: ["isHeadless": true],
        launchOptions: launchOptions
      )
    }
    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bundleURL()
  }

  override func bundleURL() -> URL? {
    #if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
    HotUpdater.bundleURL()
    #endif
  }
}
