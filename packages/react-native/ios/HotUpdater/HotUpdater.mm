#import "HotUpdater.h"
@implementation HotUpdater

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;

#pragma mark - Bundle URL Management

+ (void)reload {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

+ (void)setBundleVersion:(NSString*)bundleVersion {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setObject:bundleVersion forKey:@"HotUpdaterBundleVersion"];
        [defaults synchronize];
    });
}

+ (NSString *)getAppVersion {
   NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
   return appVersion;
}

+ (NSString *)getBundleVersion {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *bundleVersion = [defaults objectForKey:@"HotUpdaterBundleVersion"];
    if (bundleVersion && ![bundleVersion isKindOfClass:[NSNull class]] && bundleVersion.length > 0) {
        return bundleVersion;
    } else {
        return nil;
    }
}


+ (void)setBundleURL:(NSString *)localPath {
    NSLog(@"Setting bundle URL: %@", localPath);
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _bundleURL = [NSURL fileURLWithPath:localPath];
        [[NSUserDefaults standardUserDefaults] setObject:[_bundleURL absoluteString] forKey:@"HotUpdaterBundleURL"];
        [[NSUserDefaults standardUserDefaults] synchronize];
    });
}

+ (NSURL *)cachedURLFromBundle {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSString *savedURLString = [[NSUserDefaults standardUserDefaults] objectForKey:@"HotUpdaterBundleURL"];
        if (savedURLString) {
            _bundleURL = [NSURL URLWithString:savedURLString];
        }
    });

    if (_bundleURL && [[NSFileManager defaultManager] fileExistsAtPath:[_bundleURL path]]) {
        return _bundleURL;
    }
    
    return nil;
}

+ (NSURL *)fallbackURL {
    // This Support React Native 0.72.6
    #if DEBUG
        return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
    #else
        return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
    #endif
}

+ (NSURL *)bundleURL {
    return [self cachedURLFromBundle] ?: [self fallbackURL];
}

+ (NSURL *)bundleURLWithoutFallback {
    return [self cachedURLFromBundle];
}

#pragma mark - Utility Methods

+ (NSString *)convertFileSystemPathFromBasePath:(NSString *)basePath {
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:basePath];
}

+ (NSString *)stripPrefixFromPath:(NSString *)prefix path:(NSString *)path {
    if ([path hasPrefix:[NSString stringWithFormat:@"/%@/", prefix]]) {
        return [path stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@"/%@/", prefix] withString:@""];
    }
    return path;
}

+ (BOOL)updateBundle:(NSString *)prefix urls:(NSArray<NSURL *> *)urls {
    NSOperationQueue *queue = [[NSOperationQueue alloc] init];
    queue.maxConcurrentOperationCount = urls.count;

    __block BOOL allSuccess = YES;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

    for (NSURL *url in urls) {
        NSString *filename = [url lastPathComponent];
        NSString *basePath = [self stripPrefixFromPath:prefix path:[url path]];
        NSString *path = [self convertFileSystemPathFromBasePath:basePath];

        [queue addOperationWithBlock:^{
            NSData *data = [NSData dataWithContentsOfURL:url];

            if (!data) {
                NSLog(@"Failed to download data from URL: %@", url);
                allSuccess = NO;
                dispatch_semaphore_signal(semaphore);
                return;
            }

            NSFileManager *fileManager = [NSFileManager defaultManager];
            NSError *folderError;
            if (![fileManager createDirectoryAtPath:[path stringByDeletingLastPathComponent]
                        withIntermediateDirectories:YES
                                         attributes:nil
                                              error:&folderError]) {
                NSLog(@"Failed to create folder: %@", folderError);
                allSuccess = NO;
                dispatch_semaphore_signal(semaphore);
                return;
            }

            NSError *error;
            [data writeToFile:path options:NSDataWritingAtomic error:&error];

            if (error) {
                NSLog(@"Failed to save data: %@", error);
                allSuccess = NO;
            }
            
            if ([filename hasPrefix:@"index"] && [filename hasSuffix:@".bundle"]) {
                NSLog(@"Setting bundle URL: %@", path);
                [self setBundleURL:path];
            }
            dispatch_semaphore_signal(semaphore);
        }];
    }

    for (int i = 0; i < urls.count; i++) {
        dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    }
    
    if (allSuccess) {
        [self setBundleVersion:prefix];
        NSLog(@"Downloaded all files.");
    }
    return allSuccess;
}


#pragma mark - React Native Exports

RCT_EXPORT_METHOD(reload) {
    [HotUpdater reload];
}

RCT_EXPORT_METHOD(getBundleVersion:(RCTResponseSenderBlock)callback) {
    NSString *bundleVersion = [HotUpdater getBundleVersion];
    callback(@[bundleVersion ?: [NSNull null]]);
}


RCT_EXPORT_METHOD(getAppVersion:(RCTResponseSenderBlock)callback) {
    NSString *version = [HotUpdater getAppVersion];
    callback(@[version ?: [NSNull null]]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)prefix urlStrings:(NSArray<NSString *> *)urlStrings callback:(RCTResponseSenderBlock)callback) {
    NSMutableArray<NSURL *> *urls = [NSMutableArray array];
    for (NSString *urlString in urlStrings) {
        NSURL *url = [NSURL URLWithString:urlString];

        if (url) {
            [urls addObject:url];
        }
    }

    BOOL result = [HotUpdater updateBundle:prefix urls:urls];
    callback(@[@(result)]);
}
@end
