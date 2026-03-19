cmake_minimum_required(VERSION 3.10.2)
project(hotupdater_crash)

add_library(
  hotupdater-crash
  SHARED
  hotupdater_signal_handler.cpp
)

target_link_options(
  hotupdater-crash
  PRIVATE
  "-Wl,-z,max-page-size=16384"
)
