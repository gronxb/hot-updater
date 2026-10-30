require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "HotUpdater"
  s.version      = package["version"].split('.')[0..1].join('.') + '.0'
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported, :tvos => "13.4" }
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

  install_modules_dependencies(s)
end
