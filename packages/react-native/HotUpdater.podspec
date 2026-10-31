require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -Wno-comma -Wno-shorten-64-to-32'
# ios/HotUpdater/Sandbox is compiled only with the build xcconfig of a sandbox
# scheme, which sets INCLUDED_SOURCE_FILE_NAMES: any other build leaves it out,
# whatever the last `pod install` saw.
sandbox_excluded_files = "HotUpdaterSandbox*"

Pod::Spec.new do |s|
  s.name         = "HotUpdater"
  s.version      = package["version"].split('.')[0..1].join('.') + '.0'
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "13.4", :tvos => "13.4" }
  s.source       = { :git => "https://github.com/gronxb/hot-updater.git", :tag => "#{s.version}" }
  s.source_files  = "ios/**/*.{h,m,mm,swift}"
  s.public_header_files = "ios/HotUpdater/Public/*.h"
  s.private_header_files = "ios/HotUpdater/Internal/*.h"
  # ios/HotUpdater/Interface, ios/HotUpdater/Public/HotUpdater, ios/Plugins
  # and HotUpdaterInterface.swift are for Swift Package Manager builds
  # (Package.swift) only.
  s.exclude_files = [
    "ios/HotUpdater/Package.swift",
    "ios/HotUpdater/Test/**/*.{swift,h,m,mm}",
    "ios/HotUpdater/Interface/**/*",
    "ios/HotUpdater/Public/HotUpdater/**/*",
    "ios/HotUpdater/Internal/HotUpdaterInterface.swift",
    "ios/Plugins/**/*"
  ]
  s.libraries = "bz2"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "EXCLUDED_SOURCE_FILE_NAMES" => sandbox_excluded_files,
    "OTHER_SWIFT_FLAGS" => "-enable-experimental-feature AccessLevelOnImport",
    "HEADER_SEARCH_PATHS" => "\"$(DERIVED_FILE_DIR)\""
  }

  # Every build, before compiling, writes the build's MIN_BUNDLE_ID into the
  # header HotUpdaterMinBundleId.m includes, so Xcode, xcodebuild and the CLI
  # all ship the time they built.
  s.script_phases = [{
    :name => "[HotUpdater] Generate MIN_BUNDLE_ID",
    :script => File.read(File.join(__dir__, "ios/scripts/generate-min-bundle-id.zsh")),
    :shell_path => "/bin/zsh",
    :execution_position => :before_compile,
    :output_files => ["$(DERIVED_FILE_DIR)/HotUpdaterBuildMinBundleId.h"],
    :always_out_of_date => "1"
  }, {
    # Every build, before compiling, writes the fingerprint of the native
    # interface the app builds with into the header
    # HotUpdaterFingerprintHash.m includes.
    :name => "[HotUpdater] Generate fingerprint",
    :script => File.read(File.join(__dir__, "ios/scripts/generate-fingerprint-hash.zsh")),
    :shell_path => "/bin/zsh",
    :execution_position => :before_compile,
    :output_files => ["$(DERIVED_FILE_DIR)/HotUpdaterBuildFingerprintHash.h"],
    :always_out_of_date => "1"
  }]

  # Use install_modules_dependencies helper to install the dependencies if React Native version >=0.71.0.
  # See https://github.com/facebook/react-native/blob/febf6b7f33fdb4904669f99d795eba4c0f95d7bf/scripts/cocoapods/new_architecture.rb#L79.
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"

    # Don't install the dependencies when we run `pod install` in the old architecture.
    if ENV["RCT_NEW_ARCH_ENABLED"] == "1" then
      s.compiler_flags = folly_compiler_flags + " -DRCT_NEW_ARCH_ENABLED=1"
      s.pod_target_xcconfig    = {
          "EXCLUDED_SOURCE_FILE_NAMES" => sandbox_excluded_files,
          "HEADER_SEARCH_PATHS" => "\"$(PODS_ROOT)/boost\" \"$(DERIVED_FILE_DIR)\"",
          "OTHER_CPLUSPLUSFLAGS" => "-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1",
          "CLANG_CXX_LANGUAGE_STANDARD" => "c++17"
      }
      s.dependency "React-Codegen"
      s.dependency "RCT-Folly"
      s.dependency "RCTRequired"
      s.dependency "RCTTypeSafety"
      s.dependency "ReactCommon/turbomodule/core"
    end
  end
end
