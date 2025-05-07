import Foundation

// UserDefaults를 사용하여 환경설정을 관리하는 Swift 클래스
public class HotUpdaterPrefs {

    // 싱글톤 인스턴스
    public static let shared = HotUpdaterPrefs()

    private let userDefaults: UserDefaults
    private var keyPrefix: String = "" // 앱 버전을 포함한 접두사

    // private 초기화를 통해 싱글톤 보장
    private init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        // 앱 버전은 사용 전에 설정되어야 함
    }

    // 앱 버전을 설정하여 키 접두사를 초기화하는 메소드
    // HotUpdaterImpl에서 사용 시작 시 호출 필요
    public func configure(appVersion: String?) {
        // 앱 버전을 포함하여 UserDefaults 키 충돌 방지
        self.keyPrefix = "hotupdater_\(appVersion ?? "unknown")_"
        print("[HotUpdaterPrefs] Configured with appVersion: \(appVersion). Key prefix: \(self.keyPrefix)")
    }

    // 내부적으로 접두사가 붙은 키를 생성하는 helper 메소드
    private func prefixedKey(forKey key: String) -> String {
        guard !keyPrefix.isEmpty else {
            // configure가 호출되기 전에 사용하려고 하면 경고 또는 오류 처리
            print("[HotUpdaterPrefs] Warning: HotUpdaterPrefs used before configure(appVersion:) was called. Key prefix is empty.")
            // 기본값 또는 비접두 키를 사용할 수도 있지만, configure 호출을 강제하는 것이 안전
            // fatalError("HotUpdaterPrefs must be configured with an app version before use.")
             return key // 임시 방편으로 비접두 키 반환 (하지만 configure 호출 누락 시 문제 발생 가능)
        }
        return "\(keyPrefix)\(key)"
    }

    // 값을 저장하는 메소드 (기존 setItem:forKey: 와 동일 기능)
    public func setItem(_ value: String?, forKey key: String) {
        let fullKey = prefixedKey(forKey: key)
        if let valueToSet = value {
            userDefaults.set(valueToSet, forKey: fullKey)
            print("[HotUpdaterPrefs] Set '\(fullKey)' = '\(valueToSet)'")
        } else {
            userDefaults.removeObject(forKey: fullKey)
            print("[HotUpdaterPrefs] Removed '\(fullKey)'")
        }
        // userDefaults.synchronize() // synchronize는 더 이상 필요하지 않음
    }

    // 값을 가져오는 메소드 (기존 getItemForKey: 와 동일 기능)
    public func getItem(forKey key: String) -> String? {
        let fullKey = prefixedKey(forKey: key)
        let value = userDefaults.string(forKey: fullKey)
        // print("[HotUpdaterPrefs] Get '\(fullKey)' = '\(value ?? "nil")'") // 너무 빈번하게 로그가 찍힐 수 있으므로 필요시 주석 해제
        return value
    }
}