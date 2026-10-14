import Foundation
import UIKit

// The brownfield E2E host imports only this framework, as the brownfield
// guide describes: Hot Updater and React stay internal.
@_exported import ReactBrownfield
internal import HotUpdater
internal import React

/// The framework's bundle: its `main.jsbundle` and `HOT_UPDATER_*` keys.
public let ReactNativeBundle = Bundle(for: InternalClassForBundle.self)

class InternalClassForBundle {}

/// Starts React Native with Hot Updater choosing the JavaScript bundle. When
/// a scenario turns it on, `HotUpdater.prepare` checks for an update first, as
/// the brownfield guide's start function does. `launchOptions` is read once
/// React Native starts, so it can carry a URL that arrived meanwhile.
/// `onBundleLoaded` runs on the main thread once the JavaScript bundle loads.
@MainActor
public func startReactNativeWithHotUpdater(
  launchOptions: () -> [UIApplication.LaunchOptionsKey: Any]?,
  onBundleLoaded: (() -> Void)? = nil
) async {
  if let request = NativePrepareRequest.read() {
    let result = await HotUpdater.prepare(
      HotUpdaterCheckOptions(
        baseURL: request.baseURL,
        updateStrategy: request.updateStrategy == "fingerprint" ? .fingerprint : .appVersion,
        requestTimeout: (request.requestTimeoutMs ?? 5_000) / 1_000,
        bundle: ReactNativeBundle
      ),
      timeout: 10
    )
    await request.report(status: result.status)
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

/// Hands a deep link to React Native's `Linking`.
@MainActor
public func openReactNativeURL(
  _ application: UIApplication,
  url: URL,
  options: [UIApplication.OpenURLOptionsKey: Any]
) -> Bool {
  RCTLinkingManager.application(application, open: url, options: options)
}

/// The native update check a scenario turns on. The E2E control server
/// writes it to this app's user defaults; resetting the app removes it.
private struct NativePrepareRequest: Decodable {
  let baseURL: String
  let updateStrategy: String
  let nonce: String
  let requestTimeoutMs: Double?

  static func read() -> NativePrepareRequest? {
    guard let value = UserDefaults.standard.string(forKey: "HotUpdaterE2ENativePrepare") else {
      return nil
    }
    return try? JSONDecoder().decode(NativePrepareRequest.self, from: Data(value.utf8))
  }

  /// Publishes `<nonce>:<status>` to the control server's screen state.
  func report(status: HotUpdaterPrepareStatus) async {
    let name: String
    switch status {
    case .upToDate: name = "upToDate"
    case .ready: name = "ready"
    case .pending: name = "pending"
    case .failed: name = "failed"
    @unknown default: name = "failed"
    }
    guard var components = URLComponents(string: baseURL) else { return }
    components.path = "/e2e/screen-state"
    guard let url = components.url else { return }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(
      withJSONObject: ["nativePrepareResult": "\(nonce):\(name)"]
    )
    _ = try? await URLSession.shared.data(for: request)
  }
}
