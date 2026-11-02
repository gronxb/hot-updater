#if canImport(Testing)
import Foundation
import ObjectiveC
import Testing

import HotUpdaterSandboxEntryPoints

// Every call goes through the Objective-C runtime, as UIKit's do. Each class is its own,
// since wrapping changes it for the process.

private typealias Done = @convention(block) (Int) -> Void

private final class Trail: @unchecked Sendable {
    var events: [String] = []
}

private let remoteSelector = NSSelectorFromString("application:didReceiveRemoteNotification:fetchCompletionHandler:")
private let fetchSelector = NSSelectorFromString("application:performFetchWithCompletionHandler:")
private let urlSessionSelector = NSSelectorFromString("application:handleEventsForBackgroundURLSession:completionHandler:")
private let registrationSelector = NSSelectorFromString("registerForTaskWithIdentifier:usingQueue:launchHandler:")

private func callRemote(_ object: NSObject, done: @escaping Done) {
    typealias Call = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, @escaping Done) -> Void
    let call = unsafeBitCast(object.method(for: remoteSelector), to: Call.self)
    call(object, remoteSelector, "app" as NSString, ["payload": 1] as NSDictionary, done)
}

private func callFetch(_ object: NSObject, done: @escaping Done) {
    typealias Call = @convention(c) (AnyObject, Selector, AnyObject, @escaping Done) -> Void
    let call = unsafeBitCast(object.method(for: fetchSelector), to: Call.self)
    call(object, fetchSelector, "app" as NSString, done)
}

private func callUrlSession(_ object: NSObject, done: @escaping Done) {
    typealias Call = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, @escaping Done) -> Void
    let call = unsafeBitCast(object.method(for: urlSessionSelector), to: Call.self)
    call(object, urlSessionSelector, "app" as NSString, "session" as NSString, done)
}

private final class FullDelegate: NSObject {
    static let trail = Trail()

    @objc(application:didReceiveRemoteNotification:fetchCompletionHandler:)
    func remote(_ app: AnyObject, payload: NSDictionary, done: @escaping Done) {
        Self.trail.events.append("host remote \(payload["payload"] ?? "")")
        done(0)
    }

    @objc(application:performFetchWithCompletionHandler:)
    func fetch(_ app: AnyObject, done: @escaping Done) {
        Self.trail.events.append("host fetch")
        done(0)
    }

    @objc(application:handleEventsForBackgroundURLSession:completionHandler:)
    func urlSession(_ app: AnyObject, identifier: NSString, done: @escaping Done) {
        Self.trail.events.append("host session \(identifier)")
        done(0)
    }
}

private final class EmptyDelegate: NSObject {}

private class ParentDelegate: NSObject {
    static let trail = Trail()

    @objc(application:performFetchWithCompletionHandler:)
    func fetch(_ app: AnyObject, done: @escaping Done) {
        Self.trail.events.append("parent fetch")
        done(0)
    }
}

private final class ChildDelegate: ParentDelegate {}

private final class FakeScheduler: NSObject {
    static var handler: (@convention(block) (AnyObject) -> Void)?

    @objc(registerForTaskWithIdentifier:usingQueue:launchHandler:)
    func register(_ identifier: NSString, queue: AnyObject?, handler: @escaping @convention(block) (AnyObject) -> Void) -> Bool {
        Self.handler = handler
        return true
    }
}

@Suite(.serialized)
struct HotUpdaterSandboxEntryPointTests {
    @Test
    func everyEntryPointReleasesBeforeTheHostsHandlerWithItsArguments() {
        let trail = FullDelegate.trail
        HotUpdaterSandboxWrapBackgroundEntryPoints(FullDelegate.self, { reason in
            trail.events.append("entry \(reason)")
        }, 0)
        let delegate = FullDelegate()

        var completions = 0
        callRemote(delegate) { _ in completions += 1 }
        callFetch(delegate) { _ in completions += 1 }
        callUrlSession(delegate) { _ in completions += 1 }

        #expect(trail.events == [
            "entry remote notification",
            "host remote 1",
            "entry background fetch",
            "host fetch",
            "entry background URL session",
            "host session session",
        ])
        #expect(completions == 3)
    }

    @Test
    func aHostWithoutAPushHandlerGetsOneThatAnswersAfterTheDelay() async {
        let trail = Trail()
        HotUpdaterSandboxWrapBackgroundEntryPoints(EmptyDelegate.self, { reason in
            trail.events.append("entry \(reason)")
        }, 0.05)
        let delegate = EmptyDelegate()
        #expect(delegate.responds(to: remoteSelector))

        let answer = Trail()
        callRemote(delegate) { result in answer.events.append("done \(result)") }
        #expect(trail.events == ["entry remote notification"])
        // Answering at once would end the launch's time before JavaScript gets any.
        #expect(answer.events.isEmpty)

        for _ in 0 ..< 100 where answer.events.isEmpty {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        // UIBackgroundFetchResultNoData.
        #expect(answer.events == ["done 1"])
    }

    @Test
    func aHostWithoutFetchOrSessionHandlersDoesntGetThem() {
        // Only a silent push's launch needs one the host didn't declare.
        #expect(!EmptyDelegate().responds(to: fetchSelector))
        #expect(!EmptyDelegate().responds(to: urlSessionSelector))
    }

    @Test
    func anInheritedHandlerIsWrappedAndStillRuns() {
        let trail = ParentDelegate.trail
        HotUpdaterSandboxWrapBackgroundEntryPoints(ChildDelegate.self, { reason in
            trail.events.append("entry \(reason)")
        }, 0)
        callFetch(ChildDelegate()) { _ in }
        #expect(trail.events == ["entry background fetch", "parent fetch"])

        // The parent itself isn't wrapped.
        trail.events.removeAll()
        callFetch(ParentDelegate()) { _ in }
        #expect(trail.events == ["parent fetch"])
    }

    @Test
    func aRegisteredTaskReleasesOnTheMainThreadBeforeTheHostsHandler() async {
        let trail = Trail()
        HotUpdaterSandboxWrapTaskRegistration(FakeScheduler.self) { reason in
            trail.events.append("entry \(reason) main=\(Thread.isMainThread)")
        }
        typealias Register = @convention(c) (AnyObject, Selector, NSString, AnyObject?, @escaping @convention(block) (AnyObject) -> Void) -> Bool
        let scheduler = FakeScheduler()
        let register = unsafeBitCast(scheduler.method(for: registrationSelector), to: Register.self)
        let registered = register(scheduler, registrationSelector, "task", nil) { task in
            trail.events.append("host \(task)")
        }
        #expect(registered)

        // The system calls it on a queue of its own.
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                FakeScheduler.handler?("task" as NSString)
                finished.resume()
            }
        }
        #expect(trail.events == ["entry background task main=true", "host task"])
    }

    @Test
    func aClassWithoutTheRegistrationMethodIsLeftAlone() {
        HotUpdaterSandboxWrapTaskRegistration(EmptyDelegate.self) { _ in }
        #expect(!EmptyDelegate().responds(to: registrationSelector))
    }
}
#endif
