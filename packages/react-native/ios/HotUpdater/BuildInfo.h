#ifndef BuildInfo_h
#define BuildInfo_h

#ifdef __cplusplus
extern "C" {
#endif

const char* BUILD_DATE = __DATE__;
const char* BUILD_TIME = __TIME__;

#ifdef __cplusplus
}
#endif

#endif /* BuildInfo_h */