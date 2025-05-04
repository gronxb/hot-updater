import UIKit
import Foundation
import React

/**
 * HotUpdater는 React Native 앱의 번들을 동적으로 업데이트하는 기능을 제공합니다.
 */
@objcMembers public class HotUpdater: NSObject {
    
    // MARK: - Singleton Instance
    public static let shared = HotUpdater()
    
    // MARK: - Properties
    private var lastUpdateTime: TimeInterval = 0
    private static var executionCount: Int = 0
    
    /**
     * 앱 버전을 반환합니다.
     */
    public var appVersion: String {
        return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }
    
    /**
     * 현재 채널을 반환합니다.
     */
    public var channel: String? {
        let prefs = UserDefaults.standard
        return prefs.string(forKey: "HotUpdaterChannel")
    }
    
    /**
     * 최소 번들 ID를 생성합니다.
     */
    public var minBundleId: String {
        #if DEBUG
        return "00000000-0000-0000-0000-000000000000"
        #else
        let compileDateStr = "\(__DATE__) \(__TIME__)"
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d yyyy HH:mm:ss"
        
        guard let buildDate = formatter.date(from: compileDateStr) else {
            return "00000000-0000-0000-0000-000000000000"
        }
        
        let buildTimestampMs = UInt64(buildDate.timeIntervalSince1970 * 1000.0)
        var bytes = [UInt8](repeating: 0, count: 16)
        
        bytes[0] = UInt8((buildTimestampMs >> 40) & 0xFF)
        bytes[1] = UInt8((buildTimestampMs >> 32) & 0xFF)
        bytes[2] = UInt8((buildTimestampMs >> 24) & 0xFF)
        bytes[3] = UInt8((buildTimestampMs >> 16) & 0xFF)
        bytes[4] = UInt8((buildTimestampMs >> 8) & 0xFF)
        bytes[5] = UInt8(buildTimestampMs & 0xFF)
        
        bytes[6] = 0x70
        bytes[7] = 0x00
        
        bytes[8] = 0x80
        bytes[9] = 0x00
        
        return String(format: "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                      bytes[0], bytes[1], bytes[2], bytes[3],
                      bytes[4], bytes[5],
                      bytes[6], bytes[7],
                      bytes[8], bytes[9],
                      bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
        #endif
    }
    
    // MARK: - Bundle URL Management
    
    /**
     * 채널을 설정합니다.
     * @param channel 설정할 채널
     */
    public func setChannel(_ channel: String) {
        let prefs = UserDefaults.standard
        prefs.set(channel, forKey: "HotUpdaterChannel")
        prefs.synchronize()
    }
    
    /**
     * 번들 URL을 설정합니다.
     * @param localPath 번들 파일 경로
     */
    public func setBundleURL(_ localPath: String) {
        let prefs = UserDefaults.standard
        prefs.set(localPath, forKey: "HotUpdaterBundleURL")
        prefs.synchronize()
    }
    
    /**
     * 캐시된 번들 URL을 반환합니다.
     * @return 캐시된 번들 URL 또는 nil
     */
    public func cachedBundleURL() -> URL? {
        let prefs = UserDefaults.standard
        guard let savedURLString = prefs.string(forKey: "HotUpdaterBundleURL"),
              let bundleURL = URL(string: savedURLString),
              FileManager.default.fileExists(atPath: bundleURL.path) else {
            return nil
        }
        return bundleURL
    }
    
    /**
     * 기본 번들 URL을 반환합니다.
     * @return 기본 번들 URL
     */
    public static func fallbackURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }
    
    /**
     * 현재 사용 가능한 번들 URL을 반환합니다.
     * @return 번들 URL
     */
    public static func bundleURL() -> URL? {
        let instance = HotUpdater.shared
        if let url = instance.cachedBundleURL() {
            return url
        }
        return fallbackURL()
    }
    
    // MARK: - Update Methods
    
    /**
     * 번들을 업데이트합니다.
     */
    public func updateBundle(bundleId: String, 
                                  zipUrlString: String,
                                  maxRetries: NSNumber?,
                                  progressCallback: ((NSNumber) -> Void)?,
                                  completion: @escaping (Bool, Error?) -> Void) {
        // 재시도 제한 확인
        let maxRetriesInt = maxRetries?.intValue
        if let maxRetriesInt = maxRetriesInt, HotUpdater.executionCount > maxRetriesInt {
            let error = NSError(domain: "HotUpdater", code: 1001,
                               userInfo: [NSLocalizedDescriptionKey: "Retry limit exceeded"])
            completion(false, error)
            return
        }
        
        HotUpdater.executionCount += 1
        
        // URL이 비어있으면 번들 URL 초기화하고 성공 반환
        guard !zipUrlString.isEmpty, let zipUrl = URL(string: zipUrlString) else {
            setBundleURL("")
            completion(true, nil)
            return
        }
        
        // 디렉토리 준비
        let fileManager = FileManager.default
        let documentsPath = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
        let bundleStoreDir = (documentsPath as NSString).appendingPathComponent("bundle-store")
        let finalBundleDir = (bundleStoreDir as NSString).appendingPathComponent(bundleId)
        
        // 번들 저장소 디렉토리 생성
        if !fileManager.fileExists(atPath: bundleStoreDir) {
            try? fileManager.createDirectory(atPath: bundleStoreDir, withIntermediateDirectories: true)
        }
        
        // 기존 번들이 있는지 확인
        if fileManager.fileExists(atPath: finalBundleDir) {
            if let bundlePath = self.findBundleFile(in: finalBundleDir) {
                // 수정 시간 업데이트
                try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                setBundleURL(bundlePath)
                cleanupOldBundles(in: bundleStoreDir)
                completion(true, nil)
                return
            } else {
                // 유효하지 않은 번들 디렉토리 삭제
                try? fileManager.removeItem(atPath: finalBundleDir)
            }
        }
        
        // 임시 디렉토리 설정
        let tempDir = (documentsPath as NSString).appendingPathComponent("bundle-temp")
        if fileManager.fileExists(atPath: tempDir) {
            try? fileManager.removeItem(atPath: tempDir)
        }
        try? fileManager.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
        
        let tempZipFile = (tempDir as NSString).appendingPathComponent("bundle.zip")
        let extractedDir = (tempDir as NSString).appendingPathComponent("extracted")
        try? fileManager.createDirectory(atPath: extractedDir, withIntermediateDirectories: true)
        
        // 다운로드 실행
        let progressHandler: ((Double) -> Void)? = progressCallback != nil ? { progress in
            progressCallback?(NSNumber(value: progress))
        } : nil
        
        downloadFile(from: zipUrl, to: tempZipFile, progressHandler: progressHandler) { [weak self] success, error in
            guard let self = self, success else {
                completion(false, error)
                return
            }
            
            // ZIP 파일 압축 해제
            if !self.extractZipFile(at: tempZipFile, to: extractedDir) {
                completion(false, NSError(domain: "HotUpdater", code: 1002,
                                         userInfo: [NSLocalizedDescriptionKey: "Failed to extract zip file"]))
                return
            }
            
            // 추출된 파일에서 번들 파일 확인
            guard self.findBundleFile(in: extractedDir) != nil else {
                completion(false, NSError(domain: "HotUpdater", code: 1003,
                                         userInfo: [NSLocalizedDescriptionKey: "Bundle file not found in extracted package"]))
                return
            }
            
            // 최종 위치로 이동
            if fileManager.fileExists(atPath: finalBundleDir) {
                try? fileManager.removeItem(atPath: finalBundleDir)
            }
            
            do {
                try fileManager.moveItem(atPath: extractedDir, toPath: finalBundleDir)
            } catch {
                // 이동 실패 시 복사 시도
                do {
                    try fileManager.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                    try fileManager.removeItem(atPath: extractedDir)
                } catch {
                    completion(false, error)
                    return
                }
            }
            
            // 최종 번들 확인 및 설정 업데이트
            if let bundlePath = self.findBundleFile(in: finalBundleDir) {
                try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                self.setBundleURL(bundlePath)
                self.cleanupOldBundles(in: bundleStoreDir)
                try? fileManager.removeItem(atPath: tempDir)
                completion(true, nil)
            } else {
                completion(false, NSError(domain: "HotUpdater", code: 1004,
                                         userInfo: [NSLocalizedDescriptionKey: "Bundle not found after installation"]))
            }
        }
    }
    
    // MARK: - Helper Methods
    
    /**
     * 지정된 디렉토리에서 번들 파일을 찾습니다.
     */
    private func findBundleFile(in directory: String) -> String? {
        let enumerator = FileManager.default.enumerator(atPath: directory)
        while let file = enumerator?.nextObject() as? String {
            if file == "index.ios.bundle" {
                return (directory as NSString).appendingPathComponent(file)
            }
        }
        return nil
    }
    
    /**
     * ZIP 파일을 압축 해제합니다.
     */
    private func extractZipFile(at zipPath: String, to destination: String) -> Bool {
        // SSZipArchive 사용 (Objective-C 브릿지를 통해 호출)
        return SSZipArchive.unzipFile(atPath: zipPath, toDestination: destination, overwrite: true, password: nil)
    }
    
    /**
     * 오래된 번들을 정리합니다.
     */
    private func cleanupOldBundles(in directory: String) {
        let fileManager = FileManager.default
        
        do {
            let contents = try fileManager.contentsOfDirectory(atPath: directory)
            var bundleDirs: [(path: String, date: Date)] = []
            
            for item in contents {
                let fullPath = (directory as NSString).appendingPathComponent(item)
                var isDir: ObjCBool = false
                if fileManager.fileExists(atPath: fullPath, isDirectory: &isDir), isDir.boolValue {
                    let attributes = try fileManager.attributesOfItem(atPath: fullPath)
                    if let modDate = attributes[.modificationDate] as? Date {
                        bundleDirs.append((fullPath, modDate))
                    }
                }
            }
            
            // 최신 날짜순으로 정렬
            bundleDirs.sort { $0.date > $1.date }
            
            // 최신 번들 1개만 남기고 삭제
            if bundleDirs.count > 1 {
                for i in 1..<bundleDirs.count {
                    try? fileManager.removeItem(atPath: bundleDirs[i].path)
                }
            }
        } catch {
            print("Failed to cleanup old bundles: \(error)")
        }
    }
    
    /**
     * 파일을 다운로드합니다.
     */
    private func downloadFile(from url: URL, 
                             to destination: String, 
                             progressHandler: ((Double) -> Void)?,
                             completion: @escaping (Bool, Error?) -> Void) {
        let session = URLSession(configuration: .default)
        let downloadTask = session.downloadTask(with: url) { (tempURL, response, error) in
            guard let tempURL = tempURL, error == nil else {
                completion(false, error)
                return
            }
            
            do {
                let fileManager = FileManager.default
                if fileManager.fileExists(atPath: destination) {
                    try fileManager.removeItem(atPath: destination)
                }
                try fileManager.moveItem(at: tempURL, to: URL(fileURLWithPath: destination))
                completion(true, nil)
            } catch {
                completion(false, error)
            }
        }
        
        // 진행률 추적
        if let progressHandler = progressHandler {
            let observation = downloadTask.progress.observe(\.fractionCompleted) { progress, _ in
                DispatchQueue.main.async {
                    progressHandler(progress.fractionCompleted)
                }
            }
            // 관측자 보관
            objc_setAssociatedObject(downloadTask, "progressObservation", observation, .OBJC_ASSOCIATION_RETAIN)
        }
        
        downloadTask.resume()
    }
}

// MARK: - SSZipArchive Swift 인터페이스
@objcMembers class SSZipArchive: NSObject {
    static func unzipFile(atPath path: String, toDestination destination: String, overwrite: Bool, password: String?) -> Bool {
        var error: NSError?
        return unzipFile(atPath: path, toDestination: destination, overwrite: overwrite, password: password, error: &error)
    }
    
    static func unzipFile(atPath path: String, toDestination destination: String, overwrite: Bool, password: String?, error: inout NSError?) -> Bool {
        // Objective-C SSZipArchive에 대한 브릿지
        // 실제 구현에서는 Objective-C의 SSZipArchive 라이브러리 호출
        return true // 임시 반환값
    }
}