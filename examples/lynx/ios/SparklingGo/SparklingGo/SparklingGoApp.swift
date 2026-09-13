// Copyright 2025 The Sparkling Authors. All rights reserved.
// Licensed under the Apache License Version 2.0. See examples/lynx/licenses/Sparkling-LICENSE.
// Derived from Sparkling's Apache-2.0 production template at c4ce8d25c5ea277e13752d68ff1f2a66f5704240.
import Sparkling
import SparklingMacro
import SparklingMethod
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [
            UIApplication.LaunchOptionsKey: Any
        ]? = nil
    ) -> Bool {
        SPKServiceRegister.registerAll()
        SPKExecuteAllPrepareBootTask()
        do {
            PublicHost.shared = try PublicHost(
                framework: PublicHost.requestedFramework ?? "react"
            )
            return true
        } catch {
            NSLog("Public Lynx host failed: %@", error.localizedDescription)
            return false
        }
    }
}

@main
struct SparklingGoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            PublicView().ignoresSafeArea()
        }
    }
}
