#import "HotUpdaterCrashHandler.h"
#import <React/RCTLog.h>
#import <TargetConditionals.h>
#import <atomic>
#import <fcntl.h>
#import <signal.h>
#import <unistd.h>

static NSUncaughtExceptionHandler *gDefaultExceptionHandler;
static struct sigaction gPreviousHandlers[32];
static std::atomic<bool> gCrashMarkerWritten(false);
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

static void handleException(NSException *exception) {
    NSString *reason = exception.reason ?: @"Unknown exception";
    NSString *name = exception.name ?: @"Unknown";
    NSString *callStack = [exception.callStackSymbols componentsJoinedByString:@"\n"];
    NSString *errorString = [NSString stringWithFormat:@"Exception: %@\nReason: %@\nStack:\n%@", name, reason, callStack];

    writeCrashMarker(errorString, !isLaunchCompleted());

    if (gDefaultExceptionHandler) {
        gDefaultExceptionHandler(exception);
    }
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

static void installSignalHandlers(void) {
    struct sigaction action;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_SIGINFO;
    action.sa_sigaction = handleSignal;

    int signals[] = {
        SIGABRT,
        SIGILL,
        SIGSEGV,
        SIGFPE,
        SIGBUS,
        SIGTRAP,
        SIGPIPE,
        SIGSYS,
    };
    int signalCount = sizeof(signals) / sizeof(signals[0]);

    for (int i = 0; i < signalCount; i++) {
        int sig = signals[i];
        sigaction(sig, NULL, &gPreviousHandlers[sig]);
        sigaction(sig, &action, NULL);
    }
}

static void installFatalJSLogHandler(void) {
    RCTAddLogFunction(^(RCTLogLevel level,
                        __unused RCTLogSource source,
                        NSString *fileName,
                        NSNumber *lineNumber,
                        NSString *message) {
        if (level < RCTLogLevelFatal) {
            return;
        }

        NSString *location = fileName.length > 0
            ? [NSString stringWithFormat:@"%@:%@", fileName, lineNumber ?: @0]
            : @"unknown";
        NSString *errorString = [NSString stringWithFormat:@"Fatal JS Error in %@ - %@", location, message ?: @""];
        writeCrashMarker(errorString, !isLaunchCompleted());
    });
}

@implementation HotUpdaterCrashHandler

+ (void)install {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        gCrashMarkerWritten.store(false);
        ensureMarkerPathInitialized();
        [HotUpdaterCrashHandler resetLaunchCompletion];

        if (!gDefaultExceptionHandler) {
            gDefaultExceptionHandler = NSGetUncaughtExceptionHandler();
        }
        NSSetUncaughtExceptionHandler(&handleException);

        installSignalHandlers();
        installFatalJSLogHandler();
    });
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
