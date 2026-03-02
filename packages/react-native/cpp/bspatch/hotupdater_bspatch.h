#ifndef HOTUPDATER_BSPATCH_H
#define HOTUPDATER_BSPATCH_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int hotupdater_bspatch_file(
    const char *old_path,
    const char *patch_path,
    const char *new_path,
    char *error_message,
    size_t error_message_len);

#ifdef __cplusplus
}
#endif

#endif
