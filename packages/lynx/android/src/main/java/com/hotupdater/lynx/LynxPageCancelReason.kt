package com.hotupdater.lynx

/** Closed native taxonomy for an authorized pending-page cancellation. */
enum class LynxPageCancelReason(val wireValue: String) {
    NATIVE_BACK("nativeBack"),
    SPARKLING_CLOSE("sparklingClose"),
}
