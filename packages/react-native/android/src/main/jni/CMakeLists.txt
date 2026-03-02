cmake_minimum_required(VERSION 3.13)

project(hotupdater_bspatch C)

get_filename_component(ANDROID_MAIN_DIR "${CMAKE_CURRENT_LIST_DIR}" DIRECTORY)
get_filename_component(ANDROID_SRC_DIR "${ANDROID_MAIN_DIR}" DIRECTORY)
get_filename_component(ANDROID_DIR "${ANDROID_SRC_DIR}" DIRECTORY)
get_filename_component(react_native_DIR "${ANDROID_DIR}" DIRECTORY)

set(BSPATCH_DIR "${react_native_DIR}/cpp/bspatch")

add_library(
  hotupdater_bspatch
  SHARED
  bspatch_jni.c
  "${BSPATCH_DIR}/hotupdater_bspatch.c"
)

target_include_directories(
  hotupdater_bspatch
  PRIVATE
  "${BSPATCH_DIR}"
)

find_library(log-lib log)

target_link_libraries(
  hotupdater_bspatch
  ${log-lib}
)
