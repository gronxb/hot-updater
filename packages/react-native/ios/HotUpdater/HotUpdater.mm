#import "HotUpdater.h"

@implementation HotUpdater

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;

#pragma mark - Bundle URL Management

+ (void)setVersionId:(NSString*)versionId {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setObject:versionId forKey:@"HotUpdaterVersionId"];
        [defaults synchronize];
    });
}

+ (NSString *)getVersionId {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *versionId = [defaults objectForKey:@"HotUpdaterVersionId"];
    if (versionId && ![versionId isKindOfClass:[NSNull class]] && versionId.length > 0) {
        return versionId;
    } else {
        return nil;
    }
}


+ (void)setBundleURL:(NSString *)localPath {
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

#pragma mark - Utility Methods

+ (NSString *)convertFileSystemPathFromBasePath:(NSString *)basePath {
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:basePath];
}

+ (NSString *)removePrefixFromPath:(NSString *)path prefix:(NSString *)prefix {
    if ([path hasPrefix:[NSString stringWithFormat:@"/%@/", prefix]]) {
        return [path stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@"/%@/", prefix] withString:@""];
    }
    return path;
}

+ (BOOL)downloadFilesFromURLs:(NSArray<NSURL *> *)urls prefix:(NSString *)prefix {
    NSOperationQueue *queue = [[NSOperationQueue alloc] init];
    queue.maxConcurrentOperationCount = urls.count;

    __block BOOL allSuccess = YES;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

    for (NSURL *url in urls) {
        NSString *filename = [url lastPathComponent];
        NSString *basePath = [self removePrefixFromPath:[url path] prefix:prefix];
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
                [self setBundleURL:path];
            }
            dispatch_semaphore_signal(semaphore);
        }];
    }

    for (int i = 0; i < urls.count; i++) {
        dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    }
    
    [self setVersionId:prefix];
    return allSuccess;
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(getAppVersionId:(RCTResponseSenderBlock)callback) {
    NSString *versionId = [HotUpdater getVersionId];
    callback(@[versionId ?: [NSNull null]]);
}

RCT_EXPORT_METHOD(downloadFilesFromURLs:(NSArray<NSString *> *)urlStrings prefix:(NSString *)prefix callback:(RCTResponseSenderBlock)callback) {
    NSMutableArray<NSURL *> *urls = [NSMutableArray array];
    for (NSString *urlString in urlStrings) {
        NSLog(@"urlString: %@", urlString);
        NSURL *url = [NSURL URLWithString:urlString];

        if (url) {
            [urls addObject:url];
        }
    }

    BOOL result = [HotUpdater downloadFilesFromURLs:urls prefix:prefix];
    callback(@[@(result)]);
}
@end
