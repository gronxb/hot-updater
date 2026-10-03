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
  s.default_subspec = 'Core'
  s.swift_version = '5.0'
  s.frameworks = 'Foundation', 'CryptoKit', 'UIKit'

  s.subspec 'Core' do |core|
    core.source_files = [
      'Sources/HotUpdaterLynxSparkling/**/*.swift',
      'Sources/HotUpdaterLynxSparklingCore/**/*.swift'
    ]
    core.dependency 'HotUpdaterLynxArtifact', s.version.to_s
    core.dependency 'Sparkling'
    core.dependency 'SparklingMethod/DIProvider'
    core.dependency 'Sparkling-Router'
    core.dependency 'Lynx/Framework', '3.9.0'
  end

  s.subspec 'Diagnostics' do |diagnostics|
    diagnostics.source_files =
      'Sources/HotUpdaterLynxSparklingDiagnostics/**/*.swift'
    diagnostics.dependency 'HotUpdaterLynxSparkling/Core'
    diagnostics.pod_target_xcconfig = {
      'OTHER_SWIFT_FLAGS' => '$(inherited) -DHOT_UPDATER_LYNX_DIAGNOSTICS'
    }
  end
end
