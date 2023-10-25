#import "LiveUpdater.h"

@implementation LiveUpdater

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;
static dispatch_once_t setBundleURLOnceToken;

#pragma mark - Bundle URL Management

+ (void)setBundleURL:(NSURL *)url {
    dispatch_once(&setBundleURLOnceToken, ^{
        NSString *path = [self pathFromURL:url];
        
        if (![self downloadDataFromURL:url andSaveToPath:path]) {
            return;
        }

        _bundleURL = [NSURL fileURLWithPath:path];
        [[NSUserDefaults standardUserDefaults] setObject:[_bundleURL absoluteString] forKey:@"LiveUpdaterBundleURL"];
        [[NSUserDefaults standardUserDefaults] synchronize];
    });
}

+ (NSURL *)cachedURLFromBundle {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSString *savedURLString = [[NSUserDefaults standardUserDefaults] objectForKey:@"LiveUpdaterBundleURL"];
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

+ (NSString *)pathForFilename:(NSString *)filename {
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:filename];
}

+ (NSString *)pathFromURL:(NSURL *)url {
    NSString *pathComponent = url.path;

    if ([pathComponent hasPrefix:@"/"]) {
        pathComponent = [pathComponent substringFromIndex:1];
    }

    return [self pathForFilename:pathComponent];
}

+ (BOOL)downloadDataFromURL:(NSURL *)url andSaveToPath:(NSString *)path {
    NSData *data = [NSData dataWithContentsOfURL:url];

    if (!data) {
        NSLog(@"Failed to download data from URL: %@", url);
        return NO;
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSError *folderError;
    if (![fileManager createDirectoryAtPath:[path stringByDeletingLastPathComponent]
                withIntermediateDirectories:YES
                                 attributes:nil
                                      error:&folderError]) {
        NSLog(@"Failed to create folder: %@", folderError);
        return NO;
    }

    NSError *error;
    [data writeToFile:path options:NSDataWritingAtomic error:&error];

    if (error) {
        NSLog(@"Failed to save data: %@", error);
        return NO;
    }

    return YES;
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(getBundleURL:(RCTResponseSenderBlock)callback) {
    NSString *urlString = [LiveUpdater.bundleURL absoluteString];
    callback(@[urlString]);
}

RCT_EXPORT_METHOD(setBundleURL:(NSString *)urlString) {
    [LiveUpdater setBundleURL:[NSURL URLWithString:urlString]];
}

RCT_EXPORT_METHOD(downloadAndSave:(NSString *)urlString callback:(RCTResponseSenderBlock)callback) {
    NSURL *url = [NSURL URLWithString:urlString];
    NSString *path = [LiveUpdater pathFromURL:url];
    NSLog(@"Downloading %@ to %@", url, path);
    BOOL success = [LiveUpdater downloadDataFromURL:url andSaveToPath:path];
    callback(@[@(success)]);
}

@end
