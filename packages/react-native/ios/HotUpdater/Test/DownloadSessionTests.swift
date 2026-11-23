#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct DownloadSessionTests {
    // A background-session transfer the app starts while in the background is
    // always discretionary: the system may send it hours later, after the
    // link the server signed for it expired.
    @Test
    func downloadStartedInTheBackgroundRunsInTheAppProcess() {
        #expect(DownloadSessionKind.forDownload(startingIn: .background) == .inProcess)
    }

    // While the app is still on screen, the background session starts at
    // once and keeps the transfer going after the user leaves the app.
    @Test
    func downloadStartedWhileInactiveContinuesOutOfProcess() {
        #expect(DownloadSessionKind.forDownload(startingIn: .inactive) == .outOfProcess)
    }

    @Test
    func downloadStartedWhileActiveRunsInTheAppProcess() {
        #expect(DownloadSessionKind.forDownload(startingIn: .active) == .inProcess)
    }

    // A background-session task retried after the app was suspended is
    // discretionary too, so it must give up before the links it got expire.
    @Test
    func backgroundTransfersGiveUpWithinTheLinkLifetime() {
        let configuration = URLSessionDownloadService.makeBackgroundConfiguration(
            identifier: "com.hotupdater.test.\(UUID().uuidString)"
        )
        #expect(configuration.timeoutIntervalForResource <= 30 * 60)
        #expect(configuration.isDiscretionary == false)
    }
}
#endif
