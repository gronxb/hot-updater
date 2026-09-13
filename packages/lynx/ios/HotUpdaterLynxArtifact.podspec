require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'HotUpdaterLynxArtifact'
  s.version = package['version'].split('.')[0..1].join('.') + '.0'
  s.summary = 'Experimental verified Lynx artifact preparation for Hot Updater'
  s.homepage = 'https://github.com/gronxb/hot-updater'
  s.license = 'MIT'
  s.author = 'Hot Updater'
  s.source = { :git => 'https://github.com/gronxb/hot-updater.git', :tag => s.version }
  s.platforms = { :ios => '15.0', :tvos => '15.0' }
  s.source_files = 'Sources/HotUpdaterLynxArtifact/**/*.swift',
                   'Sources/HotUpdaterLynxBsdiff/**/*.{h,mm}'
  s.swift_version = '5.0'
  s.libraries = 'z', 'compression', 'bz2', 'c++'
  s.pod_target_xcconfig = { 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17' }
  s.dependency 'Lynx/Framework', '3.9.0'
  s.frameworks = 'Foundation', 'Security', 'CryptoKit'
end
