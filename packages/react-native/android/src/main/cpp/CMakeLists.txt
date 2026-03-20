cmake_minimum_required(VERSION 3.13)

project(hotupdater_recovery)

add_library(hotupdater_recovery SHARED HotUpdaterRecovery.cpp)

find_library(log-lib log)

target_link_libraries(hotupdater_recovery ${log-lib})
