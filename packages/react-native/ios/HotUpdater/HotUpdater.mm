#import "HotUpdater.h"
#import <SSZipArchive/SSZipArchive.h>

@implementation HotUpdater

RCT_EXPORT_MODULE();

#pragma mark - Bundle URL Management

+ (void)reload {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

+ (NSString *)getAppVersion {
   NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
   return appVersion;
}

+ (void)setBundleURL:(NSString *)localPath {
    NSLog(@"Setting bundle URL: %@", localPath);
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:localPath forKey:@"HotUpdaterBundleURL"];
    [defaults synchronize];
}

+ (NSURL *)cachedURLFromBundle {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *savedURLString = [defaults objectForKey:@"HotUpdaterBundleURL"];
    
    if (savedURLString) {
        NSURL *bundleURL = [NSURL URLWithString:savedURLString];
        if (bundleURL && [[NSFileManager defaultManager] fileExistsAtPath:[bundleURL path]]) {
            return bundleURL;
        }
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

+ (void)initializeOnAppUpdate {
    NSString *currentVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *savedVersion = [defaults stringForKey:@"HotUpdaterAppVersion"];

    if (![currentVersion isEqualToString:savedVersion]) {
        [defaults removeObjectForKey:@"HotUpdaterBundleURL"];
        [defaults removeObjectForKey:@"HotUpdaterBundleVersion"];
        
        [defaults setObject:currentVersion forKey:@"HotUpdaterAppVersion"];
        [defaults synchronize];
    }
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
    if (url == nil) {
        [self setBundleURL:nil];
        return YES;
    }
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
        if ([file isEqualToString:@"index.ios.bundle"]) {
            filename = file;
            break;
        }
    }

    if (filename) {
        NSString *bundlePath = [extractedPath stringByAppendingPathComponent:filename];
        NSLog(@"Setting bundle URL: %@", bundlePath);
        [self setBundleURL:bundlePath];
    } else {
        NSLog(@"index.ios.bundle not found.");
        return NO;
    }

    NSLog(@"Downloaded and extracted file successfully.");

    return YES;
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(initializeOnAppUpdate) {
    [HotUpdater initializeOnAppUpdate];
}

RCT_EXPORT_METHOD(reload) {
    [HotUpdater reload];
}

RCT_EXPORT_METHOD(getAppVersion:(RCTResponseSenderBlock)callback) {
    NSString *version = [HotUpdater getAppVersion];
    callback(@[version ?: [NSNull null]]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)prefix downloadUrl:(NSString *)urlString callback:(RCTResponseSenderBlock)callback) {
    NSURL *url = nil;
    if (urlString != nil) {
        url = [NSURL URLWithString:urlString];
    }

    BOOL result = [HotUpdater updateBundle:prefix url:url];
    callback(@[@(result)]);
}

@end
