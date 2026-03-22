import Foundation
import UIKit

final class CohortService {
    private let userDefaults: UserDefaults

    // Keep the legacy key so existing custom cohorts continue to work.
    private let cohortKey = "HotUpdater_CustomCohort"
    private let fallbackIdentifierKey = "HotUpdater_FallbackCohortIdentifier"

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    private func hashString(_ value: String) -> Int32 {
        var hash: Int32 = 0

        for scalar in value.unicodeScalars {
            hash = (hash &* 31) &+ Int32(scalar.value)
        }

        return hash
    }

    private func defaultNumericCohort(for identifier: String) -> String {
        let hash = Int64(hashString(identifier))
        let normalized = Int((hash % 1000 + 1000) % 1000) + 1
        return String(normalized)
    }

    private func fallbackIdentifier() -> String {
        if let fallbackId = userDefaults.string(forKey: fallbackIdentifierKey), !fallbackId.isEmpty {
            return fallbackId
        }

        let fallbackId = UUID().uuidString
        userDefaults.set(fallbackId, forKey: fallbackIdentifierKey)
        return fallbackId
    }

    func setCohort(_ cohort: String) {
        if cohort.isEmpty {
            return
        }
        userDefaults.set(cohort, forKey: cohortKey)
    }

    func getCohort() -> String {
        if let cohort = userDefaults.string(forKey: cohortKey), !cohort.isEmpty {
            return cohort
        }

        let initialCohort: String
        if let idfv = UIDevice.current.identifierForVendor?.uuidString, !idfv.isEmpty {
            initialCohort = defaultNumericCohort(for: idfv)
        } else {
            initialCohort = defaultNumericCohort(for: fallbackIdentifier())
        }

        userDefaults.set(initialCohort, forKey: cohortKey)
        return initialCohort
    }
}
