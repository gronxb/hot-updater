// The gate's background entry points, apart from UIKit so tests can drive them.
#import "HotUpdaterSandboxEntryPoints.h"

#import <objc/runtime.h>

/// UIBackgroundFetchResultNoData.
static const NSInteger kNoData = 1;

/// What a class answers with now, inherited or its own, or NULL.
static IMP OriginalOf(Class cls, SEL selector) {
  Method method = class_getInstanceMethod(cls, selector);
  return method ? method_getImplementation(method) : NULL;
}

/// Runs `entry` on the main thread and returns once it has.
static void RunOnMain(HotUpdaterSandboxEntry entry, NSString *reason) {
  if (NSThread.isMainThread) {
    entry(reason);
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      entry(reason);
    });
  }
}

void HotUpdaterSandboxWrapBackgroundEntryPoints(
    Class cls,
    HotUpdaterSandboxEntry entry,
    NSTimeInterval unhandledPushSeconds) {
  // A launch for a silent push is suspended before anything else could start React
  // Native when the host has no handler, so it gets one, which answers after most of
  // the time the system allows.
  SEL remote = NSSelectorFromString(@"application:didReceiveRemoteNotification:fetchCompletionHandler:");
  void (*originalRemote)(id, SEL, id, id, id) = (void *)OriginalOf(cls, remote);
  class_replaceMethod(
      cls, remote,
      imp_implementationWithBlock(^(id self, id app, id payload, void (^done)(NSInteger)) {
        RunOnMain(entry, @"remote notification");
        if (originalRemote) {
          originalRemote(self, remote, app, payload, done);
          return;
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(unhandledPushSeconds * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
                         done(kNoData);
                       });
      }),
      "v@:@@@?");

  SEL fetch = NSSelectorFromString(@"application:performFetchWithCompletionHandler:");
  void (*originalFetch)(id, SEL, id, id) = (void *)OriginalOf(cls, fetch);
  if (originalFetch) {
    class_replaceMethod(
        cls, fetch,
        imp_implementationWithBlock(^(id self, id app, id done) {
          RunOnMain(entry, @"background fetch");
          originalFetch(self, fetch, app, done);
        }),
        "v@:@@?");
  }

  SEL urlSession = NSSelectorFromString(@"application:handleEventsForBackgroundURLSession:completionHandler:");
  void (*originalUrlSession)(id, SEL, id, id, id) = (void *)OriginalOf(cls, urlSession);
  if (originalUrlSession) {
    class_replaceMethod(
        cls, urlSession,
        imp_implementationWithBlock(^(id self, id app, id identifier, id done) {
          RunOnMain(entry, @"background URL session");
          originalUrlSession(self, urlSession, app, identifier, done);
        }),
        "v@:@@@?");
  }
}

void HotUpdaterSandboxWrapTaskRegistration(Class scheduler, HotUpdaterSandboxEntry entry) {
  SEL registration = NSSelectorFromString(@"registerForTaskWithIdentifier:usingQueue:launchHandler:");
  BOOL (*original)(id, SEL, id, id, id) = (void *)OriginalOf(scheduler, registration);
  if (!original) return;
  class_replaceMethod(
      scheduler, registration,
      imp_implementationWithBlock(^BOOL(id self, id identifier, id queue, void (^handler)(id)) {
        void (^wrapped)(id) = ^(id task) {
          RunOnMain(entry, @"background task");
          handler(task);
        };
        return original(self, registration, identifier, queue, wrapped);
      }),
      "B@:@@@?");
}
