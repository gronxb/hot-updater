cmake_minimum_required(VERSION 3.13)

project(hotupdater_bspatch C)

add_library(
  hotupdater_bspatch
  SHARED
  bspatch_jni.c
  ../../../../cpp/bspatch/hotupdater_bspatch.c
)

target_include_directories(
  hotupdater_bspatch
  PRIVATE
  ../../../../cpp/bspatch
)

find_library(log-lib log)
find_library(bz2-lib bz2)

target_link_libraries(
  hotupdater_bspatch
  ${log-lib}
  ${bz2-lib}
)
