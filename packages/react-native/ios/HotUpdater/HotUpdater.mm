#import "HotUpdater.h"
#import <SSZipArchive/SSZipArchive.h>

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

+ (NSNumber *)getBundleVersion {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *bundleVersion = [defaults objectForKey:@"HotUpdaterBundleVersion"];
    
    if (bundleVersion) {
      return @([bundleVersion integerValue]);
    }

    return @(-1);
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

+ (BOOL)extractZipFileAtPath:(NSString *)filePath toDestination:(NSString *)destinationPath {
    NSError *error = nil;
    BOOL success = [SSZipArchive unzipFileAtPath:filePath toDestination:destinationPath overwrite:YES password:nil error:&error];
    if (!success) {
        NSLog(@"Failed to unzip file: %@", error);
    }
    return success;
}

+ (BOOL)updateBundle:(NSString *)prefix url:(NSURL *)url {
    NSString *basePath = [self stripPrefixFromPath:prefix path:[url path]];
    NSString *path = [self convertFileSystemPathFromBasePath:basePath];

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

    NSString *extractedPath = [path stringByDeletingLastPathComponent];
    if (![self extractZipFileAtPath:path toDestination:extractedPath]) {
        NSLog(@"Failed to extract zip file.");
        return NO;
    }

    NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:extractedPath];
    NSString *filename = nil;
    for (NSString *file in enumerator) {
        if ([file isEqualToString:@"index.ios.bundle.js"]) {
            filename = file;
            break;
        }
    }

    if (filename) {
        NSString *bundlePath = [extractedPath stringByAppendingPathComponent:filename];
        NSLog(@"Setting bundle URL: %@", bundlePath);
        [self setBundleURL:bundlePath];
    } else {
        NSLog(@"index.ios.bundle.js not found.");
        return NO;
    }

    [self setBundleVersion:prefix];
    NSLog(@"Downloaded and extracted file successfully.");

    return YES;
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(reload) {
    [HotUpdater reload];
}

RCT_EXPORT_METHOD(getBundleVersion:(RCTResponseSenderBlock)callback) {
    NSNumber *bundleVersion = [HotUpdater getBundleVersion];
    callback(@[bundleVersion]);
}


RCT_EXPORT_METHOD(getAppVersion:(RCTResponseSenderBlock)callback) {
    NSString *version = [HotUpdater getAppVersion];
    callback(@[version ?: [NSNull null]]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)prefix urlString:(NSString *)urlString callback:(RCTResponseSenderBlock)callback) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) {
        callback(@[@(NO)]);
        return;
    }

    BOOL result = [HotUpdater updateBundle:prefix url:url];
    callback(@[@(result)]);
}
@end
