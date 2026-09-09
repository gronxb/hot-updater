import Foundation
import HotUpdaterRecovery
import XCTest

final class RecoverySurfaceStartTests: XCTestCase {
    private func onRuntimeThread(named name: String = "com.facebook.react.runtime.JavaScript", _ work: @escaping () -> Void) {
        let completed = DispatchSemaphore(value: 0)
        let thread = Thread {
            autoreleasepool { work() }
            completed.signal()
        }
        thread.name = name
        thread.start()
        XCTAssertEqual(completed.wait(timeout: .now() + 5), .success)
    }

    @MainActor
    func testFailedRuntimeCannotStartReusedSurface() async {
        let surface = NSObject()
        let handler = Unmanaged.passUnretained(surface).toOpaque()
        let recovered = expectation(description: "a runtime without pending starts can recover")

        onRuntimeThread {
            HotUpdaterMarkFailedRuntime()
            XCTAssertTrue(HotUpdaterIsFailedRuntime())
            XCTAssertFalse(HotUpdaterBeginSurfaceStart(handler))
            HotUpdaterMarkFailedRuntime()
            XCTAssertFalse(HotUpdaterBeginSurfaceStart(handler))
            HotUpdaterAfterSurfaceStarts { recovered.fulfill() }
        }
        await fulfillment(of: [recovered], timeout: 5)

        // RCTHost reuses the surface, but the healthy runtime has its own thread.
        onRuntimeThread {
            XCTAssertFalse(HotUpdaterIsFailedRuntime())
            XCTAssertTrue(HotUpdaterBeginSurfaceStart(handler))
            HotUpdaterFinishSurfaceStart(handler)
        }

        HotUpdaterMarkFailedRuntime()
        XCTAssertFalse(HotUpdaterIsFailedRuntime())
        onRuntimeThread(named: "native-worker") {
            HotUpdaterMarkFailedRuntime()
            XCTAssertFalse(HotUpdaterIsFailedRuntime())
        }
    }

    @MainActor
    func testRecoveryWaitsForAllPreviouslyQueuedSurfaceStarts() async {
        let firstSurface = NSObject()
        let secondSurface = NSObject()
        let first = Unmanaged.passUnretained(firstSurface).toOpaque()
        let second = Unmanaged.passUnretained(secondSurface).toOpaque()
        let recovered = expectation(description: "recovery after animation driver setup finishes")
        var didRecover = false

        onRuntimeThread {
            XCTAssertTrue(HotUpdaterBeginSurfaceStart(first))
            XCTAssertFalse(HotUpdaterBeginSurfaceStart(first))
            XCTAssertTrue(HotUpdaterBeginSurfaceStart(second))
            HotUpdaterMarkFailedRuntime()
            HotUpdaterAfterSurfaceStarts {
                XCTAssertTrue(Thread.isMainThread)
                didRecover = true
                recovered.fulfill()
            }
        }

        // An early async fatal can arrive after start queued its native work.
        // A free main queue alone must not allow reload to reset the presenter.
        await mainQueueTurn()
        XCTAssertFalse(didRecover)
        HotUpdaterFinishSurfaceStart(first)
        await mainQueueTurn()
        XCTAssertFalse(didRecover)
        HotUpdaterFinishSurfaceStart(second)
        await fulfillment(of: [recovered], timeout: 5)
        XCTAssertTrue(didRecover)
    }

    @MainActor
    func testSynchronousStartCompletionDoesNotDeadlockRecovery() async {
        let surface = NSObject()
        let handler = Unmanaged.passUnretained(surface).toOpaque()
        let recovered = expectation(description: "older RN synchronous start is already drained")
        onRuntimeThread {
            XCTAssertTrue(HotUpdaterBeginSurfaceStart(handler))
            HotUpdaterFinishSurfaceStart(handler)
            HotUpdaterMarkFailedRuntime()
            HotUpdaterAfterSurfaceStarts { recovered.fulfill() }
        }
        await fulfillment(of: [recovered], timeout: 5)
    }

    @MainActor
    private func mainQueueTurn() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}
