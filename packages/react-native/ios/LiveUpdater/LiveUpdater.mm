#import "LiveUpdater.h"

@implementation LiveUpdater

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;
static dispatch_once_t setBundleURLOnceToken;

#pragma mark - Bundle URL Management

+ (void)setBundleURL:(NSURL *)url {
    dispatch_once(&setBundleURLOnceToken, ^{
        NSData *data = [NSData dataWithContentsOfURL:url];

        if (!data) {
            NSLog(@"Failed to download data from URL: %@", url);
            return;
        }

        NSString *path = [self pathForFilename:[url lastPathComponent]];

        NSError *error;
        [data writeToFile:path options:NSDataWritingAtomic error:&error];

        if (error) {
            NSLog(@"Failed to save data: %@", error);
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

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(getBundleURL:(RCTResponseSenderBlock)callback) {
    NSString *urlString = [LiveUpdater.bundleURL absoluteString];
    callback(@[urlString]);
}

RCT_EXPORT_METHOD(setBundleURL:(NSString *)urlString) {
    [LiveUpdater setBundleURL:[NSURL URLWithString:urlString]];
}

@end
