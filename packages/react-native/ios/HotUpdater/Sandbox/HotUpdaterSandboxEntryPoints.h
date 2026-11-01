#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Called with what's starting, on the main thread, before the host's handler runs.
typedef void (^HotUpdaterSandboxEntry)(NSString *reason);

/// Wraps an app delegate class's background entry points. A silent push's handler
/// is added when the host has none, and completes after `unhandledPushSeconds`.
FOUNDATION_EXPORT void HotUpdaterSandboxWrapBackgroundEntryPoints(
    Class cls,
    HotUpdaterSandboxEntry entry,
    NSTimeInterval unhandledPushSeconds);

/// Wraps the handlers `BGTaskScheduler`'s registration method receives.
FOUNDATION_EXPORT void HotUpdaterSandboxWrapTaskRegistration(Class scheduler, HotUpdaterSandboxEntry entry);

NS_ASSUME_NONNULL_END
