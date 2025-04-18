#import "HotUpdaterPrefs.h"

@interface HotUpdaterPrefs ()
@property (nonatomic, strong) NSUserDefaults *userDefaults;
@property (nonatomic, copy) NSString *suiteName;
@end

@implementation HotUpdaterPrefs

+ (instancetype)sharedInstanceWithAppVersion:(NSString *)appVersion {
    static HotUpdaterPrefs *instance = nil;
    static NSString *cachedVersion = nil;
    @synchronized(self) {
        if (instance == nil) {
            instance = [[HotUpdaterPrefs alloc] initWithAppVersion:appVersion];
            cachedVersion = appVersion;
        } else if (![cachedVersion isEqualToString:appVersion]) {
            NSString *oldSuiteName = [NSString stringWithFormat:@"HotUpdaterPrefs_%@", cachedVersion];
            [[NSUserDefaults standardUserDefaults] removePersistentDomainForName:oldSuiteName];
            instance = [[HotUpdaterPrefs alloc] initWithAppVersion:appVersion];
            cachedVersion = appVersion;
        }
    }
    return instance;
}

- (instancetype)initWithAppVersion:(NSString *)appVersion {
    self = [super init];
    if (self) {
        _suiteName = [NSString stringWithFormat:@"HotUpdaterPrefs_%@", appVersion];
        _userDefaults = [[NSUserDefaults alloc] initWithSuiteName:_suiteName];
    }
    return self;
}

- (NSString *)getItemForKey:(NSString *)key {
    return [self.userDefaults objectForKey:key];
}

- (void)setItem:(NSString *)value forKey:(NSString *)key {
    [self.userDefaults setObject:value forKey:key];
    [self.userDefaults synchronize];
}

- (void)removeItemForKey:(NSString *)key {
    [self.userDefaults removeObjectForKey:key];
    [self.userDefaults synchronize];
}

@end