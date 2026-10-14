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
/// a scenario turns it on, a `HotUpdaterInstance` checks for an update first,
/// as the brownfield guide's start function does. `launchOptions` is read once
/// React Native starts, so it can carry a URL that arrived meanwhile.
/// `onBundleLoaded` runs on the main thread once the JavaScript bundle loads.
@MainActor
public func startReactNativeWithHotUpdater(
  launchOptions: () -> [UIApplication.LaunchOptionsKey: Any]?,
  onBundleLoaded: (() -> Void)? = nil
) async {
  if let request = NativeUpdateCheckRequest.read() {
    await request.report(status: await checkForUpdate(request))
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

/// The brownfield guide's update check: checks, and waits up to the request's
/// timeout for a required update, which then runs in this start. The timeout
/// ends the wait, not the download.
private func checkForUpdate(_ request: NativeUpdateCheckRequest) async -> String {
  guard let hotUpdater = try? HotUpdaterInstance(
    HotUpdaterOptions(
      baseURL: request.baseURL,
      requestTimeout: (request.requestTimeoutMs ?? 5_000) / 1_000,
      bundle: ReactNativeBundle
    )
  ) else {
    return "failed"
  }
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
private struct NativeUpdateCheckRequest: Decodable {
  let baseURL: String
  let updateStrategy: String
  let nonce: String
  let requestTimeoutMs: Double?
  let checkTimeoutMs: Double?

  static func read() -> NativeUpdateCheckRequest? {
    guard let value = UserDefaults.standard.string(forKey: "HotUpdaterE2ENativeCheck") else {
      return nil
    }
    return try? JSONDecoder().decode(NativeUpdateCheckRequest.self, from: Data(value.utf8))
  }

  /// Publishes `<nonce>:<status>` to the control server's screen state.
  func report(status name: String) async {
    guard var components = URLComponents(string: baseURL) else { return }
    components.path = "/e2e/screen-state"
    guard let url = components.url else { return }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(
      withJSONObject: ["nativeCheckResult": "\(nonce):\(name)"]
    )
    _ = try? await URLSession.shared.data(for: request)
  }
}
