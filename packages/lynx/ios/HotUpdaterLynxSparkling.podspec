require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'HotUpdaterLynxSparkling'
  s.version = package['version'].split('.')[0..1].join('.') + '.0'
  s.summary = 'Sparkling host integration for Hot Updater Lynx'
  s.homepage = 'https://github.com/gronxb/hot-updater'
  s.license = { :type => 'MIT', :file => 'LICENSE' }
  s.author = 'Hot Updater'
  s.source = { :git => 'https://github.com/gronxb/hot-updater.git', :tag => s.version }
  s.platforms = { :ios => '15.0' }
  s.source_files = [
    'Sources/HotUpdaterLynxSparkling/**/*.swift',
    'Sources/HotUpdaterLynxSparklingDiagnostics/**/*.swift'
  ]
  s.swift_version = '5.0'
  s.dependency 'HotUpdaterLynxArtifact', s.version.to_s
  s.dependency 'Sparkling'
  s.dependency 'SparklingMethod/DIProvider'
  s.dependency 'Lynx/Framework', '3.9.0'
  s.frameworks = 'Foundation', 'CryptoKit', 'UIKit'
end
