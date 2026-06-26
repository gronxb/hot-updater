import Foundation

final class InstallIdService {
    private let userDefaults: UserDefaults
    private let installIdKey = "HotUpdater_InstallId"

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    func getInstallId() -> String {
        if let installId = userDefaults.string(forKey: installIdKey), !installId.isEmpty {
            return installId
        }

        let generated = UUID().uuidString
        userDefaults.set(generated, forKey: installIdKey)
        return generated
    }
}
