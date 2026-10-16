import Foundation
import UIKit

// The brownfield E2E host imports only this framework, as the brownfield
// guide describes: Hot Updater and React stay internal.
@_exported import ReactBrownfield
internal import HotUpdater
internal import React
internal import React_RCTAppDelegate
internal import ReactAppDependencyProvider

/// The framework's bundle: its `main.jsbundle` and `HOT_UPDATER_*` keys.
public let ReactNativeBundle = Bundle(for: InternalClassForBundle.self)

class InternalClassForBundle {}

/// Starts React Native with Hot Updater choosing the JavaScript bundle. When
/// a scenario turns it on, a `HotUpdaterInstance` checks for an update first,
/// as the brownfield guide's start function does. `launchOptions` is read once
/// React Native starts, so it can carry a URL that arrived meanwhile.
/// `onBundleLoaded` runs on the main thread once the JavaScript bundle loads.
@MainActor
public func startReactNativeWithHotUpdater(
  launchOptions: () -> [UIApplication.LaunchOptionsKey: Any]?,
  onBundleLoaded: (() -> Void)? = nil
) async {
  if let request = NativeUpdateCheckRequest.read(key: NativeUpdateCheckRequest.mainKey) {
    let status: String
    if let hotUpdater = try? HotUpdaterInstance(
      HotUpdaterOptions(
        baseURL: request.baseURL,
        requestTimeout: request.requestTimeout,
        bundle: ReactNativeBundle
      )
    ) {
      status = await checkForUpdate(hotUpdater, request)
    } else {
      status = "failed"
    }
    await request.report(status: status, field: "nativeCheckResult")
  }
  ReactNativeBrownfield.shared.bundle = ReactNativeBundle
  ReactNativeBrownfield.shared.bundleURLOverride = {
    HotUpdater.bundleURL(bundle: ReactNativeBundle)
  }
  ReactNativeBrownfield.shared.startReactNative(
    launchOptions: launchOptions().map { options in
      Dictionary(uniqueKeysWithValues: options.map { (AnyHashable($0.key), $0.value) })
    },
    preloadBundle: false,
    onBundleLoaded: onBundleLoaded
  )
}

/// The brownfield guide's update check for `hotUpdater`, run before the
/// React Native runtime that uses it starts: checks, and waits up to the
/// request's timeout for a required update, which then runs in this start.
/// Any other update downloads in the background and runs at the next start.
/// The timeout ends the wait, not the download.
private func checkForUpdate(
  _ hotUpdater: HotUpdaterInstance,
  _ request: NativeUpdateCheckRequest
) async -> String {
  let options = HotUpdaterCheckOptions(
    updateStrategy: request.updateStrategy == "fingerprint" ? .fingerprint : .appVersion
  )
  let timeout = (request.checkTimeoutMs ?? 10_000) / 1_000
  return await withTaskGroup(of: String.self) { group in
    group.addTask {
      do {
        guard let update = try await hotUpdater.checkForUpdate(options) else {
          return "upToDate"
        }
        // A newer Release of the bundle this start runs: nothing to download.
        if update.transitionKind == "ADOPT_RELEASE" {
          return try await update.updateBundle() ? "upToDate" : "failed"
        }
        guard update.shouldForceUpdate else {
          Task { _ = try? await update.updateBundle() } // Downloads in the background.
          return "pending"
        }
        return try await update.updateBundle() ? "ready" : "failed"
      } catch is CancellationError {
        return "pending"
      } catch {
        return "failed"
      }
    }
    group.addTask {
      try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
      return "pending"
    }
    let status = await group.next() ?? "failed"
    group.cancelAll()
    return status
  }
}

/// Whether a scenario turned on the second Hot Updater instance, `widget`.
/// The host then leaves room for it under the example.
public var isHotUpdaterWidgetEnabled: Bool {
  NativeUpdateCheckRequest.read(key: NativeUpdateCheckRequest.widgetKey) != nil
}

/// The widget's React Native root, or nil when no scenario turned it on.
///
/// The widget is a second React Native runtime with its own embedded bundle,
/// `HotUpdaterWidget.bundle` (its `main.jsbundle` and `HOT_UPDATER_*` keys,
/// channel `widget`), and its own Hot Updater instance, named `widget`: its
/// bundles, crash history, and recovery stay apart from the example's.
/// Like the example's start, it checks for its update natively before its
/// runtime starts, and reports the status as `widgetNativeCheckResult`; its
/// JavaScript only calls `HotUpdater.init`.
/// React Native Brownfield runs one runtime, so this one has its own factory.
/// Create it once the example's bundle has loaded: React Native Brownfield
/// takes the first bundle load in the process for the example's.
@MainActor
public func makeHotUpdaterWidgetView() async -> UIView? {
  if let widgetRuntime {
    return widgetRuntime.view()
  }
  guard let request = NativeUpdateCheckRequest.read(key: NativeUpdateCheckRequest.widgetKey),
        let bundleURL = ReactNativeBundle.url(forResource: "HotUpdaterWidget", withExtension: "bundle"),
        let bundle = Bundle(url: bundleURL),
        let instance = try? HotUpdaterInstance(
          HotUpdaterOptions(
            baseURL: request.baseURL,
            requestTimeout: request.requestTimeout,
            bundle: bundle,
            name: "widget"
          )
        ) else {
    return nil
  }
  await request.report(
    status: await checkForUpdate(instance, request),
    field: "widgetNativeCheckResult"
  )
  // Another call may have created it while this one checked.
  if let widgetRuntime {
    return widgetRuntime.view()
  }
  let runtime = WidgetRuntime(instance: instance)
  widgetRuntime = runtime
  return runtime.view()
}

@MainActor private var widgetRuntime: WidgetRuntime?

/// Keeps the widget's factory, and with it its React host, for the process.
@MainActor
private final class WidgetRuntime {
  private let delegate: WidgetReactNativeDelegate
  private let factory: RCTReactNativeFactory

  init(instance: HotUpdaterInstance) {
    delegate = WidgetReactNativeDelegate(instance: instance)
    delegate.dependencyProvider = RCTAppDependencyProvider()
    factory = RCTReactNativeFactory(delegate: delegate)
  }

  func view() -> UIView {
    factory.rootViewFactory.view(
      withModuleName: "HotUpdaterWidget",
      initialProperties: nil,
      launchOptions: nil
    )
  }
}

/// Starts the widget runtime with the bundle its Hot Updater instance picks:
/// its staged update, or its embedded `main.jsbundle`.
private final class WidgetReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  private let instance: HotUpdaterInstance

  init(instance: HotUpdaterInstance) {
    self.instance = instance
    super.init()
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bundleURL()
  }

  override func bundleURL() -> URL? {
    instance.bundleURL()
  }
}

/// Hands a deep link to React Native's `Linking`.
@MainActor
public func openReactNativeURL(
  _ application: UIApplication,
  url: URL,
  options: [UIApplication.OpenURLOptionsKey: Any]
) -> Bool {
  RCTLinkingManager.application(application, open: url, options: options)
}

/// A native update check a scenario turns on: the example's (`mainKey`), or
/// the widget's, which also turns the widget on (`widgetKey`). The E2E control
/// server writes it to this app's user defaults; resetting the app removes it.
private struct NativeUpdateCheckRequest: Decodable {
  static let mainKey = "HotUpdaterE2ENativeCheck"
  static let widgetKey = "HotUpdaterE2EWidget"

  let baseURL: String
  let updateStrategy: String
  let nonce: String
  let requestTimeoutMs: Double?
  let checkTimeoutMs: Double?

  var requestTimeout: TimeInterval { (requestTimeoutMs ?? 5_000) / 1_000 }

  static func read(key: String) -> NativeUpdateCheckRequest? {
    guard let value = UserDefaults.standard.string(forKey: key) else {
      return nil
    }
    return try? JSONDecoder().decode(NativeUpdateCheckRequest.self, from: Data(value.utf8))
  }

  /// Publishes `<nonce>:<status>` as `field` of the control server's screen
  /// state.
  func report(status name: String, field: String) async {
    guard var components = URLComponents(string: baseURL) else { return }
    components.path = "/e2e/screen-state"
    guard let url = components.url else { return }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(
      withJSONObject: [field: "\(nonce):\(name)"]
    )
    _ = try? await URLSession.shared.data(for: request)
  }
}
