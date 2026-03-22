import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import HotUpdater


@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?
  private let e2eCohortCommandKey = "HotUpdater_E2ECohortCommand"

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    consumePendingCohortCommand()

    if let launchUrl = launchOptions?[.url] as? URL {
      _ = handleCohortURL(launchUrl)
    }

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "HotUpdaterExample",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  func application(
    _ application: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    handleCohortURL(url)
  }

  private func handleCohortURL(_ url: URL) -> Bool {
    guard url.scheme == "hotupdaterexample", url.host == "cohort" else {
      return false
    }

    let pathComponents = url.pathComponents.filter { $0 != "/" }
    guard let command = pathComponents.first else {
      return false
    }

    let hotUpdater = HotUpdaterImpl()

    if (command == "set" || command == "restore"),
       let cohort = pathComponents.dropFirst().first,
       !cohort.isEmpty {
      hotUpdater.setCohort(cohort.lowercased())
      return true
    }

    return false
  }

  private func consumePendingCohortCommand() {
    let defaults = UserDefaults.standard
    guard let command = defaults.string(forKey: e2eCohortCommandKey),
          !command.isEmpty else {
      return
    }

    defaults.removeObject(forKey: e2eCohortCommandKey)

    if command.hasPrefix("set:") || command.hasPrefix("restore:") {
      let parts = command.split(separator: ":", maxSplits: 1)
      guard parts.count == 2, let nextCohort = parts.last, !nextCohort.isEmpty else {
        return
      }

      HotUpdaterImpl().setCohort(String(nextCohort).lowercased())
    }
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
//  var hotUpdater = HotUpdaterImpl(identifier: "main")
  
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    HotUpdater.bundleURL()
#endif
  }
}
