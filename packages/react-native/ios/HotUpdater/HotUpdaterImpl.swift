import UIKit
import Foundation
// React import는 이 파일에서 직접적으로 필요하지 않을 수 있습니다.
// import React

@objcMembers public class HotUpdaterImpl: NSObject {

    public static let shared = HotUpdaterImpl()
    private override init() { super.init() }

    // 앱 버전 (Info.plist에서 가져옴)
    public var appVersion: String {
        return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    // 현재 설정된 채널 (UserDefaults에서 읽기)
    public var channel: String? {
        let prefs = UserDefaults.standard
        return prefs.string(forKey: "HotUpdaterChannel")
    }

    // 최소 허용 번들 ID (빌드 시간 기준 UUID 생성)
    public var minBundleId: String {
        #if DEBUG
        // 디버그 모드에서는 항상 업데이트 허용
        return "00000000-0000-0000-0000-000000000000"
        #else
        // BuildInfo.h가 브리징 헤더에 포함되어 있어야 함
        guard let buildDateStr = String(cString: BUILD_DATE, encoding: .utf8),
              let buildTimeStr = String(cString: BUILD_TIME, encoding: .utf8) else {
            print("HotUpdater Error: Could not read BUILD_DATE or BUILD_TIME C strings.")
            return "00000000-0000-0000-0000-000000000000" // Fallback
        }

        let compileDateStr = "\(buildDateStr) \(buildTimeStr)"
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX") // POSIX locale for fixed format parsing
        formatter.dateFormat = "MMM d yyyy HH:mm:ss" // Example: May 6 2025 10:08:35

        // Try parsing with single-digit day
        formatter.dateFormat = "MMM d yyyy HH:mm:ss"
        var buildDate = formatter.date(from: compileDateStr)

        // If parsing failed, try with double-digit day
        if buildDate == nil {
            formatter.dateFormat = "MMM dd yyyy HH:mm:ss" // Example: May 06 2025 10:08:35
            buildDate = formatter.date(from: compileDateStr)
        }

        // Fallback parsing attempt (handle extra spaces often inserted by __DATE__)
        if buildDate == nil {
            let cleanedDateStr = compileDateStr.replacingOccurrences(of: "  ", with: " ") // Replace double space with single
            formatter.dateFormat = "MMM d yyyy HH:mm:ss"
            buildDate = formatter.date(from: cleanedDateStr)
            if buildDate == nil {
                formatter.dateFormat = "MMM dd yyyy HH:mm:ss"
                buildDate = formatter.date(from: cleanedDateStr)
            }
        }

        guard let finalBuildDate = buildDate else {
            print("HotUpdater Error: Could not parse build date string '\(compileDateStr)'. Using fallback minBundleId.")
            return "00000000-0000-0000-0000-000000000000"
        }

        return generateBundleId(from: finalBuildDate)
        #endif
    }

    // 날짜로부터 UUID v7 유사 형식 생성 (시간 순서 보장)
    private func generateBundleId(from date: Date) -> String {
         let buildTimestampMs = UInt64(date.timeIntervalSince1970 * 1000.0)
         var bytes = [UInt8](repeating: 0, count: 16)

         // unixtime_ms (48 bits)
         bytes[0] = UInt8((buildTimestampMs >> 40) & 0xFF)
         bytes[1] = UInt8((buildTimestampMs >> 32) & 0xFF)
         bytes[2] = UInt8((buildTimestampMs >> 24) & 0xFF)
         bytes[3] = UInt8((buildTimestampMs >> 16) & 0xFF)
         bytes[4] = UInt8((buildTimestampMs >> 8) & 0xFF)
         bytes[5] = UInt8(buildTimestampMs & 0xFF)

         // version (4 bits = 0b0111) + rand_a (12 bits)
         bytes[6] = 0x70 | UInt8.random(in: 0...15) // Set version to 7 (0111)
         bytes[7] = UInt8.random(in: 0...255)

         // variant (2 bits = 0b10) + rand_b (62 bits)
         bytes[8] = 0x80 | UInt8.random(in: 0...63) // Set variant to RFC 4122 (10xx)
         bytes[9] = UInt8.random(in: 0...255)
         for i in 10..<16 { bytes[i] = UInt8.random(in: 0...255) }

         // Format as UUID string
         return String(format: "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                       bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                       bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
    }

    // 채널 설정 (UserDefaults에 저장)
    public func updateChannel(_ channel: String) {
        let prefs = UserDefaults.standard
        prefs.set(channel, forKey: "HotUpdaterChannel")
        prefs.synchronize() // 변경사항 즉시 반영 (필수는 아님)
        print("HotUpdaterImpl: Channel updated to \(channel)")
    }

    // 현재 활성화된 번들 URL 설정 (UserDefaults에 저장)
    public func setBundleURL(_ localPath: String) {
        let prefs = UserDefaults.standard
        if localPath.isEmpty {
             // 경로가 비어있으면 저장된 URL 제거 (Fallback 사용 유도)
             prefs.removeObject(forKey: "HotUpdaterBundleURL")
             print("HotUpdaterImpl: Bundle URL cleared.")
        } else {
             // 유효한 경로 저장
             prefs.set(localPath, forKey: "HotUpdaterBundleURL")
             print("HotUpdaterImpl: Bundle URL set to \(localPath)")
        }
        prefs.synchronize() // 변경사항 즉시 반영
    }

    // --- Static Methods ---

    // 앱에서 사용할 최종 번들 URL 반환 (캐시 -> Fallback 순)
    public static func bundleURL() -> URL? {
        let url = cachedBundleURL() ?? fallbackURL()
        #if DEBUG
        print("HotUpdaterImpl: Using bundle URL: \(url?.absoluteString ?? "nil")")
        #endif
        return url
    }

    // UserDefaults에 저장된 유효한 번들 URL 반환
    private static func cachedBundleURL() -> URL? {
        let prefs = UserDefaults.standard
        guard let savedURLString = prefs.string(forKey: "HotUpdaterBundleURL"),
              !savedURLString.isEmpty,
              let bundleURL = URL(string: savedURLString),
              FileManager.default.fileExists(atPath: bundleURL.path) else {
            // 저장된 URL이 없거나, 있더라도 해당 파일이 존재하지 않으면 nil 반환
            if prefs.string(forKey: "HotUpdaterBundleURL") != nil {
                print("HotUpdaterImpl Warning: Cached bundle URL exists but file not found at path. Clearing cache.")
                prefs.removeObject(forKey: "HotUpdaterBundleURL")
                prefs.synchronize()
            }
            return nil
        }
        // 유효한 캐시 URL 반환
        return bundleURL
    }

    // 앱 내부에 포함된 기본 번들 URL 반환
    static func fallbackURL() -> URL? {
        // 기본적으로 main.jsbundle을 찾음
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }

    // --- Update Logic ---

    // 번들 업데이트 시작
    public func updateBundle(bundleId: String,
                             zipUrlString: String,
                             progressCallback: ((NSNumber) -> Void)?,
                             completion: @escaping (Bool, Error?) -> Void) {

        print("HotUpdaterImpl: Starting updateBundle for ID \(bundleId) from URL: \(zipUrlString)")

        // 1. URL 유효성 검사 또는 클리어 요청 처리
        guard !zipUrlString.isEmpty, let zipUrl = URL(string: zipUrlString) else {
            print("HotUpdaterImpl: zipUrlString is empty. Clearing bundle URL.")
            setBundleURL("") // 저장된 번들 URL 제거 -> Fallback 사용
            completion(true, nil) // URL 비우는 것은 성공으로 간주
            return
        }

        let fileManager = FileManager.default

        // 2. 저장 경로 설정
        guard let documentsPath = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
             completion(false, NSError(domain: "HotUpdaterImpl", code: 1000, userInfo: [NSLocalizedDescriptionKey: "Could not access Documents directory."]))
             return
        }
        let bundleStoreDir = documentsPath.appendingPathComponent("bundle-store") // 모든 번들 저장 폴더
        let finalBundleDir = bundleStoreDir.appendingPathComponent(bundleId) // 이번 번들 최종 위치

        // 3. bundle-store 디렉토리 생성 (없으면)
        do {
            if !fileManager.fileExists(atPath: bundleStoreDir.path) {
                 try fileManager.createDirectory(at: bundleStoreDir, withIntermediateDirectories: true, attributes: nil)
            }
        } catch {
            completion(false, NSError(domain: "HotUpdaterImpl", code: 1001, userInfo: [NSLocalizedDescriptionKey: "Failed to create bundle-store directory: \(error.localizedDescription)"]))
            return
        }

        // 4. 이미 해당 번들이 유효하게 존재하는지 확인
        if fileManager.fileExists(atPath: finalBundleDir.path) {
            if let bundlePath = self.findBundleFile(in: finalBundleDir.path) {
                print("HotUpdaterImpl: Bundle \(bundleId) already exists and is valid.")
                 do {
                     // 최근 사용됨을 표시하기 위해 수정 날짜 갱신 (cleanup 시 활용)
                     try fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir.path)
                     setBundleURL(URL(fileURLWithPath: bundlePath).absoluteString) // 현재 번들로 설정
                     cleanupOldBundles(in: bundleStoreDir.path) // 오래된 번들 정리
                     completion(true, nil) // 이미 존재하므로 성공
                 } catch {
                      print("HotUpdaterImpl Warning: Failed to update modification date for \(finalBundleDir.path): \(error)")
                      // 날짜 갱신 실패해도 치명적이지 않으므로 성공 처리
                      setBundleURL(URL(fileURLWithPath: bundlePath).absoluteString)
                      cleanupOldBundles(in: bundleStoreDir.path)
                      completion(true, nil)
                 }
                 return // 이미 존재하므로 더 이상 진행 안 함
             } else {
                 // 폴더는 있지만 내부 번들 파일이 없거나 잘못된 경우, 해당 폴더 삭제 후 진행
                 print("HotUpdaterImpl Warning: Bundle directory \(finalBundleDir.path) exists but is invalid. Removing.")
                 try? fileManager.removeItem(at: finalBundleDir)
             }
         }

        // 5. 임시 다운로드 및 압축 해제 폴더 준비
        let tempDir = documentsPath.appendingPathComponent("bundle-temp") // 임시 작업 폴더
        if fileManager.fileExists(atPath: tempDir.path) {
            try? fileManager.removeItem(at: tempDir) // 이전 작업 찌꺼기 제거
        }
        do {
            try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: nil)
        } catch {
           completion(false, NSError(domain: "HotUpdaterImpl", code: 1001, userInfo: [NSLocalizedDescriptionKey: "Failed to create temp directory: \(error.localizedDescription)"]))
           return
        }
        let tempZipFile = tempDir.appendingPathComponent("bundle.zip") // 다운로드될 zip 파일 경로
        let extractedDir = tempDir.appendingPathComponent("extracted") // 압축 해제될 폴더 경로
        do {
             try fileManager.createDirectory(at: extractedDir, withIntermediateDirectories: true, attributes: nil)
        } catch {
           completion(false, NSError(domain: "HotUpdaterImpl", code: 1001, userInfo: [NSLocalizedDescriptionKey: "Failed to create temp extraction directory: \(error.localizedDescription)"]))
           return
        }

        // 6. 파일 다운로드
        downloadFile(from: zipUrl, to: tempZipFile.path, progressHandler: progressCallback) { [weak self] success, error in
            guard let self = self else { return } // self 참조 확인

            guard success, error == nil else {
                print("HotUpdaterImpl Error: Download failed. Error: \(error?.localizedDescription ?? "Unknown download error")")
                try? fileManager.removeItem(at: tempDir) // 임시 폴더 정리
                completion(false, error ?? NSError(domain: "HotUpdaterImpl", code: 1002, userInfo: [NSLocalizedDescriptionKey: "Download failed."]))
                return
            }
            print("HotUpdaterImpl: Download successful.")

            // 7. 압축 해제 (SSZipArchive 사용 가정)
            // *** 중요: 실제 SSZipArchive 라이브러리 연동 및 Bridging Header 설정 필요 ***
            if !SSZipArchive.unzipFile(atPath: tempZipFile.path, toDestination: extractedDir.path, overwrite: true, password: nil) {
                 print("HotUpdaterImpl Error: Failed to extract zip file at \(tempZipFile.path)")
                 try? fileManager.removeItem(at: tempDir) // 임시 폴더 정리
                 completion(false, NSError(domain: "HotUpdaterImpl", code: 1003, userInfo: [NSLocalizedDescriptionKey: "Failed to extract zip file"]))
                 return
             }
             print("HotUpdaterImpl: Extraction successful to \(extractedDir.path).")

            // 8. 압축 해제된 파일에서 번들 파일(.jsbundle) 찾기
            guard let extractedBundlePath = self.findBundleFile(in: extractedDir.path) else {
                 print("HotUpdaterImpl Error: Bundle file not found in extracted package at \(extractedDir.path)")
                 try? fileManager.removeItem(at: tempDir) // 임시 폴더 정리
                 completion(false, NSError(domain: "HotUpdaterImpl", code: 1004, userInfo: [NSLocalizedDescriptionKey: "Bundle file not found in extracted package"]))
                 return
            }
            print("HotUpdaterImpl: Found bundle file in extracted package: \(extractedBundlePath)")

            // 9. 압축 해제된 폴더를 최종 번들 위치로 이동/복사
            if fileManager.fileExists(atPath: finalBundleDir.path) {
                // 만약을 위해 다시 확인하고 삭제 (이론상 위에서 처리되었어야 함)
                try? fileManager.removeItem(at: finalBundleDir)
            }

            do {
                // 먼저 이동(move) 시도 (빠름)
                try fileManager.moveItem(at: extractedDir, to: finalBundleDir)
                 print("HotUpdaterImpl: Successfully moved bundle to final destination: \(finalBundleDir.path)")
            } catch let moveError {
                 print("HotUpdaterImpl Warning: Failed to move extracted files: \(moveError.localizedDescription). Attempting copy.")
                // 이동 실패 시 복사(copy) 시도 (느리지만 안전할 수 있음)
                do {
                    try fileManager.copyItem(at: extractedDir, to: finalBundleDir)
                    try? fileManager.removeItem(at: extractedDir) // 복사 성공 시 원본 삭제 시도
                    print("HotUpdaterImpl: Successfully copied bundle to final destination.")
                } catch let copyError {
                     // 복사마저 실패하면 최종 실패
                     print("HotUpdaterImpl Error: Failed to copy extracted files: \(copyError.localizedDescription)")
                     try? fileManager.removeItem(at: tempDir) // 임시 폴더 정리
                     completion(false, moveError) // 원인이 된 moveError를 반환하는 것이 더 나을 수 있음
                     return
                }
            }

            // 10. 최종 위치에서 번들 파일 재확인 및 설정
            if let finalBundlePath = self.findBundleFile(in: finalBundleDir.path) {
                  print("HotUpdaterImpl: Verified bundle file in final location: \(finalBundlePath)")
                 do {
                     // 최근 사용됨 표시 (수정 날짜 갱신)
                     try fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir.path)
                 } catch {
                     // 날짜 갱신 실패는 경고만 출력
                     print("HotUpdaterImpl Warning: Failed to update modification date for final bundle directory \(finalBundleDir.path): \(error)")
                 }
                 self.setBundleURL(URL(fileURLWithPath: finalBundlePath).absoluteString) // 새 번들로 설정
                 self.cleanupOldBundles(in: bundleStoreDir.path) // 오래된 번들 정리
                 try? fileManager.removeItem(at: tempDir) // 임시 폴더 최종 정리
                 print("HotUpdaterImpl: Update successful for bundle \(bundleId).")
                 completion(true, nil) // 모든 과정 성공
             } else {
                 // 이동/복사 후에도 번들 파일이 없으면 심각한 오류
                 print("HotUpdaterImpl Error: Bundle file not found in final location after move/copy: \(finalBundleDir.path)")
                 try? fileManager.removeItem(at: tempDir) // 임시 폴더 정리
                 try? fileManager.removeItem(at: finalBundleDir) // 실패한 최종 폴더 정리
                 completion(false, NSError(domain: "HotUpdaterImpl", code: 1005, userInfo: [NSLocalizedDescriptionKey: "Bundle not found after installation"]))
             }
        }
    }

    // 지정된 디렉토리 내에서 .jsbundle 파일 찾기
    private func findBundleFile(in directory: String) -> String? {
        let fileManager = FileManager.default
        do {
            let items = try fileManager.contentsOfDirectory(atPath: directory)
            for item in items {
                if item.lowercased().hasSuffix(".jsbundle") {
                    return URL(fileURLWithPath: directory).appendingPathComponent(item).path
                }
            }
            // 하위 폴더 1단계까지 탐색 (예: "ios" 폴더 안에 있는 경우)
            for item in items {
                 let subDirPath = URL(fileURLWithPath: directory).appendingPathComponent(item).path
                 var isDir: ObjCBool = false
                 if fileManager.fileExists(atPath: subDirPath, isDirectory: &isDir), isDir.boolValue {
                     let subItems = try fileManager.contentsOfDirectory(atPath: subDirPath)
                     for subItem in subItems {
                         if subItem.lowercased().hasSuffix(".jsbundle") {
                             return URL(fileURLWithPath: subDirPath).appendingPathComponent(subItem).path
                         }
                     }
                 }
            }
        } catch {
            print("HotUpdaterImpl Error: Failed to list contents of directory \(directory): \(error)")
        }
        return nil // 찾지 못함
    }

    // 오래된 번들 정리 (가장 최근 5개만 남김)
    private func cleanupOldBundles(in directory: String) {
        let fileManager = FileManager.default
        let maxBundlesToKeep = 5 // 유지할 최대 번들 수

        do {
            let bundleDirs = try fileManager.contentsOfDirectory(at: URL(fileURLWithPath: directory),
                                                                 includingPropertiesForKeys: [.contentModificationDateKey],
                                                                 options: .skipsHiddenFiles)

            // 수정 날짜 기준으로 정렬 (최신이 나중에 오도록)
            let sortedDirs = bundleDirs.sorted { url1, url2 in
                do {
                    let date1 = try url1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? Date.distantPast
                    let date2 = try url2.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? Date.distantPast
                    return date1 < date2 // 오름차순 (오래된 것이 먼저)
                } catch {
                    print("HotUpdaterImpl Warning: Could not get modification date during sort - \(error)")
                    return false
                }
            }

            // 유지할 개수보다 많으면 오래된 것부터 삭제
            if sortedDirs.count > maxBundlesToKeep {
                let bundlesToRemove = sortedDirs.prefix(sortedDirs.count - maxBundlesToKeep)
                for dirToRemove in bundlesToRemove {
                    // 현재 사용 중인 번들은 삭제하지 않음
                    if let currentBundleURL = HotUpdaterImpl.cachedBundleURL(),
                       URL(fileURLWithPath: dirToRemove.path) == URL(fileURLWithPath: currentBundleURL.deletingLastPathComponent().path) {
                         print("HotUpdaterImpl: Skipping cleanup of currently active bundle directory: \(dirToRemove.path)")
                        continue
                    }

                    print("HotUpdaterImpl: Cleaning up old bundle: \(dirToRemove.path)")
                    try? fileManager.removeItem(at: dirToRemove)
                }
            }
        } catch {
            print("HotUpdaterImpl Error: Failed during cleanupOldBundles in \(directory): \(error)")
        }
    }

    // 파일 다운로드 함수 (URLSession 사용)
    private func downloadFile(from url: URL,
                             to destinationPath: String,
                             progressHandler: ((NSNumber) -> Void)?,
                             completion: @escaping (Bool, Error?) -> Void) {

        let session = URLSession(configuration: .default, delegate: nil, delegateQueue: nil)
        var downloadTask: URLSessionDownloadTask?
        var observation: NSKeyValueObservation? // KVO를 위한 관찰자 참조

        downloadTask = session.downloadTask(with: url) { (tempLocalURL, response, error) in
            // 다운로드 완료 후 KVO 관찰 중지
            observation?.invalidate()
            observation = nil

            // 기본적인 에러 처리
            guard let tempLocalURL = tempLocalURL, error == nil else {
                 print("HotUpdaterImpl Downloader: Download error: \(error?.localizedDescription ?? "Unknown URLSession error")")
                 // 메인 스레드에서 콜백 호출 보장
                 DispatchQueue.main.async { completion(false, error) }
                 return
             }

            // HTTP 상태 코드 확인
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                 print("HotUpdaterImpl Downloader: Invalid HTTP response: \(httpResponse.statusCode)")
                 let httpError = NSError(domain: "HotUpdaterImpl.Download", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP Error \(httpResponse.statusCode)"])
                 DispatchQueue.main.async { completion(false, httpError) }
                 return
             }

            // 다운로드된 임시 파일을 최종 목적지로 이동
            do {
                let fileManager = FileManager.default
                let destinationURL = URL(fileURLWithPath: destinationPath)
                // 목적지에 이미 파일이 있으면 삭제 (덮어쓰기)
                if fileManager.fileExists(atPath: destinationPath) {
                    try fileManager.removeItem(at: destinationURL)
                }
                try fileManager.moveItem(at: tempLocalURL, to: destinationURL)
                 print("HotUpdaterImpl Downloader: Successfully moved downloaded file to \(destinationPath)")
                 DispatchQueue.main.async { completion(true, nil) } // 성공 콜백
            } catch let fileError {
                // 파일 이동 실패 시 에러 처리
                print("HotUpdaterImpl Downloader: File move error from \(tempLocalURL.path) to \(destinationPath): \(fileError.localizedDescription)")
                DispatchQueue.main.async { completion(false, fileError) } // 실패 콜백
            }
        }

        // 진행률 콜백이 있으면 KVO 설정
        if let handler = progressHandler {
            observation = downloadTask?.progress.observe(\.fractionCompleted, options: [.new]) { progress, change in
                // fractionCompleted 값 변경 시 콜백 호출
                if let fraction = change.newValue {
                     // 메인 스레드에서 UI 업데이트 등을 할 수 있도록 보장
                     DispatchQueue.main.async {
                         handler(NSNumber(value: fraction))
                     }
                 }
            }
        }

        // 다운로드 시작
        downloadTask?.resume()
    }
}


// --- SSZipArchive 스텁 ---
// 실제 라이브러리 연동이 필요합니다. CocoaPods 등으로 설치 후 Bridging Header에 추가하세요.
@objcMembers class SSZipArchive: NSObject {
    static func unzipFile(atPath path: String, toDestination destination: String, overwrite: Bool, password: String?) -> Bool {
        print("SSZipArchive STUB: Called unzipFileAtPath: '\(path)' to '\(destination)'. *** YOU NEED THE REAL SSZipArchive LIBRARY LINKED! ***")
        // ** 실제 구현에서는 이 부분을 라이브러리 호출로 바꿔야 합니다. **
        // return true // 테스트용 성공 시뮬레이션
        return false // 테스트용 실패 시뮬레이션 (압축 해제 실패 테스트)
    }
}