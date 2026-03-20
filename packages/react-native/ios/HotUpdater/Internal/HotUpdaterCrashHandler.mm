#import "HotUpdaterCrashHandler.h"
#import <React/RCTAssert.h>
#import <TargetConditionals.h>
#import <atomic>
#import <fcntl.h>
#import <signal.h>
#import <unistd.h>

static NSUncaughtExceptionHandler *gPreviousExceptionHandler;
static RCTFatalHandler gPreviousFatalHandler;
static RCTFatalExceptionHandler gPreviousFatalExceptionHandler;
static RCTFatalHandler gInstalledFatalHandler;
static RCTFatalExceptionHandler gInstalledFatalExceptionHandler;
static struct sigaction gPreviousHandlers[32];
static std::atomic<bool> gCrashMarkerWritten(false);
static std::atomic<bool> gMonitoringActive(false);
static char gMarkerPath[512];
static char gLaunchMarkerPath[512];

static NSString *HotUpdaterStorageDirectory(void) {
#if TARGET_OS_TV
    return NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject ?: @"";
#else
    return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject ?: @"";
#endif
}

static void ensureMarkerPathInitialized(void) {
    if (gMarkerPath[0] != '\0') {
        return;
    }

    NSString *directory = HotUpdaterStorageDirectory();
    if (directory.length == 0) {
        return;
    }

    snprintf(gMarkerPath, sizeof(gMarkerPath), "%s/%s", directory.UTF8String, "hotupdater_crash.marker");
    snprintf(gLaunchMarkerPath, sizeof(gLaunchMarkerPath), "%s/%s", directory.UTF8String, "hotupdater_launch.marker");
}

static NSString *trimCrashLog(NSString *crashLog) {
    NSString *safeCrashLog = crashLog ?: @"";
    if (safeCrashLog.length > 900) {
        return [safeCrashLog substringToIndex:900];
    }
    return safeCrashLog;
}

static BOOL isLaunchCompleted(void) {
    if (gLaunchMarkerPath[0] == '\0') {
        return NO;
    }

    return [[NSFileManager defaultManager] fileExistsAtPath:[NSString stringWithUTF8String:gLaunchMarkerPath]];
}

static NSString *formattedReactErrorString(NSString *message, NSArray<NSDictionary<NSString *, id> *> *stack) {
    NSString *safeMessage = message.length > 0 ? message : @"Unknown React Native fatal error";
    NSString *formatted = RCTFormatError(safeMessage, stack, -1);
    return formatted.length > 0 ? formatted : safeMessage;
}

static NSString *formattedFatalNSError(NSError *error) {
    if (!error) {
        return @"Unknown React Native fatal error";
    }

    NSArray<NSDictionary<NSString *, id> *> *stack = error.userInfo[RCTJSStackTraceKey];
    NSMutableString *formatted = [formattedReactErrorString(error.localizedDescription ?: @"Unknown React Native fatal error", stack) mutableCopy];

    NSString *objcStack = error.userInfo[RCTObjCStackTraceKey];
    if (objcStack.length > 0) {
        [formatted appendFormat:@"\nObjC stack:\n%@", objcStack];
    }

    return formatted;
}

static NSException *fatalExceptionFromError(NSError *error) {
    NSString *safeDescription = error.localizedDescription ?: @"Unknown React Native fatal error";
    NSString *name = [NSString stringWithFormat:@"%@: %@", RCTFatalExceptionName, safeDescription];
    NSString *message = RCTFormatError(safeDescription, error.userInfo[RCTJSStackTraceKey], 175);

    NSMutableDictionary *userInfo = [error.userInfo mutableCopy] ?: [NSMutableDictionary new];
    userInfo[@"RCTUntruncatedMessageKey"] = RCTFormatError(safeDescription, error.userInfo[RCTJSStackTraceKey], -1);

    return [[NSException alloc] initWithName:name reason:message userInfo:userInfo];
}

static void writeCrashMarker(NSString *crashLog, BOOL shouldRollback) {
    bool expected = false;
    if (!gCrashMarkerWritten.compare_exchange_strong(expected, true)) {
        return;
    }

    ensureMarkerPathInitialized();
    if (gMarkerPath[0] == '\0') {
        return;
    }

    NSDictionary *payload = @{
        @"crashLog": trimCrashLog(crashLog),
        @"shouldRollback": @(shouldRollback),
        @"timestamp": @((long long)([[NSDate date] timeIntervalSince1970] * 1000))
    };
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (!jsonData) {
        return;
    }

    NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString *markerPath = [NSString stringWithUTF8String:gMarkerPath];
    [jsonString writeToFile:markerPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static void writeCrashMarkerJsonSafe(int signalValue, int launchCompleted) {
    if (gMarkerPath[0] == '\0') {
        return;
    }

    int fd = open(gMarkerPath, O_CREAT | O_WRONLY | O_TRUNC, 0600);
    if (fd >= 0) {
        char json[512];
        int len = snprintf(
            json,
            sizeof(json),
            "{\"signal\":%d,\"shouldRollback\":%s,\"crashLog\":\"signal=%d\\n\"}",
            signalValue,
            launchCompleted ? "false" : "true",
            signalValue
        );
        if (len > 0 && len < (int)sizeof(json)) {
            (void)write(fd, json, len);
        }
        close(fd);
    }
}

static void crashWithDefaultReactBehavior(NSError *error) {
    @throw fatalExceptionFromError(error);
}

static void crashWithDefaultReactBehaviorForException(NSException *exception) {
    @throw exception;
}

static void handleException(NSException *exception) {
    NSString *reason = exception.reason ?: @"Unknown exception";
    NSString *name = exception.name ?: @"Unknown";
    NSString *callStack = [exception.callStackSymbols componentsJoinedByString:@"\n"];
    NSString *errorString = [NSString stringWithFormat:@"Exception: %@\nReason: %@\nStack:\n%@", name, reason, callStack];

    writeCrashMarker(errorString, !isLaunchCompleted());

    if (gPreviousExceptionHandler) {
        gPreviousExceptionHandler(exception);
    }
}

static void handleFatalError(NSError *error) {
    writeCrashMarker(formattedFatalNSError(error), !isLaunchCompleted());

    if (gPreviousFatalHandler) {
        gPreviousFatalHandler(error);
        return;
    }

    crashWithDefaultReactBehavior(error);
}

static void handleFatalException(NSException *exception) {
    NSString *reason = exception.reason ?: @"Unknown fatal exception";
    NSString *name = exception.name ?: @"Unknown";
    NSString *callStack = [exception.callStackSymbols componentsJoinedByString:@"\n"];
    NSString *errorString = [NSString stringWithFormat:@"Fatal React Native exception: %@\nReason: %@\nStack:\n%@", name, reason, callStack];
    writeCrashMarker(errorString, !isLaunchCompleted());

    if (gPreviousFatalExceptionHandler) {
        gPreviousFatalExceptionHandler(exception);
        return;
    }

    crashWithDefaultReactBehaviorForException(exception);
}

static void handleSignal(int signalValue, siginfo_t *info, void *context) {
    writeCrashMarkerJsonSafe(signalValue, isLaunchCompleted() ? 1 : 0);

    if (signalValue >= 0 && signalValue < 32) {
        struct sigaction *prev = &gPreviousHandlers[signalValue];
        if (prev->sa_handler != SIG_DFL && prev->sa_handler != SIG_IGN && prev->sa_handler != NULL) {
            if (prev->sa_sigaction != handleSignal) {
                if (prev->sa_flags & SA_SIGINFO) {
                    prev->sa_sigaction(signalValue, info, context);
                } else if (prev->sa_handler != SIG_DFL && prev->sa_handler != SIG_IGN) {
                    prev->sa_handler(signalValue);
                }
            }
        }
    }

    signal(signalValue, SIG_DFL);
    raise(signalValue);
}

static void installFatalHandlers(void) {
    gPreviousFatalHandler = RCTGetFatalHandler();
    gInstalledFatalHandler = ^(NSError *error) {
        handleFatalError(error);
    };
    RCTSetFatalHandler(gInstalledFatalHandler);

    gPreviousFatalExceptionHandler = RCTGetFatalExceptionHandler();
    gInstalledFatalExceptionHandler = ^(NSException *exception) {
        handleFatalException(exception);
    };
    RCTSetFatalExceptionHandler(gInstalledFatalExceptionHandler);
}

static const int gHandledSignals[] = {
    SIGABRT,
    SIGILL,
    SIGSEGV,
    SIGFPE,
    SIGBUS,
    SIGTRAP,
    SIGPIPE,
    SIGSYS,
};

static void installSignalHandlers(void) {
    struct sigaction action;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_SIGINFO;
    action.sa_sigaction = handleSignal;

    int signalCount = sizeof(gHandledSignals) / sizeof(gHandledSignals[0]);

    for (int i = 0; i < signalCount; i++) {
        int sig = gHandledSignals[i];
        sigaction(sig, NULL, &gPreviousHandlers[sig]);
        sigaction(sig, &action, NULL);
    }
}

static BOOL isCurrentSignalHandlerInstalled(int signalValue) {
    struct sigaction currentAction;
    sigaction(signalValue, NULL, &currentAction);

    if ((currentAction.sa_flags & SA_SIGINFO) != 0) {
        return currentAction.sa_sigaction == handleSignal;
    }

    return currentAction.sa_handler == (void (*)(int))handleSignal;
}

static void restoreFatalHandlers(void) {
    if (RCTGetFatalHandler() == gInstalledFatalHandler) {
        RCTSetFatalHandler(gPreviousFatalHandler);
    }
    if (RCTGetFatalExceptionHandler() == gInstalledFatalExceptionHandler) {
        RCTSetFatalExceptionHandler(gPreviousFatalExceptionHandler);
    }

    gPreviousFatalHandler = nil;
    gPreviousFatalExceptionHandler = nil;
}

static void restoreExceptionHandler(void) {
    if (NSGetUncaughtExceptionHandler() == &handleException) {
        NSSetUncaughtExceptionHandler(gPreviousExceptionHandler);
    }

    gPreviousExceptionHandler = NULL;
}

static void restoreSignalHandlers(void) {
    int signalCount = sizeof(gHandledSignals) / sizeof(gHandledSignals[0]);
    for (int i = 0; i < signalCount; i++) {
        int sig = gHandledSignals[i];
        if (isCurrentSignalHandlerInstalled(sig)) {
            sigaction(sig, &gPreviousHandlers[sig], NULL);
        }
    }
}

@implementation HotUpdaterCrashHandler

+ (void)install {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        ensureMarkerPathInitialized();
    });
    [HotUpdaterCrashHandler startMonitoring];
}

+ (void)startMonitoring {
    ensureMarkerPathInitialized();
    gCrashMarkerWritten.store(false);
    [HotUpdaterCrashHandler resetLaunchCompletion];

    bool expected = false;
    if (!gMonitoringActive.compare_exchange_strong(expected, true)) {
        return;
    }

    gPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
    NSSetUncaughtExceptionHandler(&handleException);

    installFatalHandlers();
    installSignalHandlers();
}

+ (void)stopMonitoring {
    bool expected = true;
    if (!gMonitoringActive.compare_exchange_strong(expected, false)) {
        return;
    }

    restoreFatalHandlers();
    restoreExceptionHandler();
    restoreSignalHandlers();
}

+ (void)markLaunchCompleted {
    ensureMarkerPathInitialized();
    if (gLaunchMarkerPath[0] == '\0') {
        return;
    }

    [[NSFileManager defaultManager] createFileAtPath:[NSString stringWithUTF8String:gLaunchMarkerPath]
                                            contents:nil
                                          attributes:nil];
}

+ (void)resetLaunchCompletion {
    ensureMarkerPathInitialized();
    if (gLaunchMarkerPath[0] == '\0') {
        return;
    }

    NSString *launchMarkerPath = [NSString stringWithUTF8String:gLaunchMarkerPath];
    [[NSFileManager defaultManager] removeItemAtPath:launchMarkerPath error:nil];
}

@end
