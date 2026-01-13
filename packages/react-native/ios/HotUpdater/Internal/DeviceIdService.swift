import Foundation
import UIKit

final class DeviceIdService {
    private let userDefaults: UserDefaults

    private let customUserIdKey = "HotUpdater_CustomUserId"
    private let fallbackUserIdKey = "HotUpdater_FallbackUserId"

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    func setUserId(_ customId: String) {
        if customId.isEmpty {
            userDefaults.removeObject(forKey: customUserIdKey)
            return
        }
        userDefaults.set(customId, forKey: customUserIdKey)
    }

    func getUserId() -> String {
        if let customId = userDefaults.string(forKey: customUserIdKey), !customId.isEmpty {
            return customId
        }

        if let idfv = UIDevice.current.identifierForVendor?.uuidString, !idfv.isEmpty {
            return idfv
        }

        if let fallbackId = userDefaults.string(forKey: fallbackUserIdKey), !fallbackId.isEmpty {
            return fallbackId
        }

        let fallbackId = UUID().uuidString
        userDefaults.set(fallbackId, forKey: fallbackUserIdKey)
        return fallbackId
    }
}

