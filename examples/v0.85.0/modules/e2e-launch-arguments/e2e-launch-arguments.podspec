Pod::Spec.new do |s|
  s.name         = "e2e-launch-arguments"
  s.version      = "0.0.0"
  s.summary      = "Reads the E2E runner's launch arguments for the example app."
  s.homepage     = "https://github.com/gronxb/hot-updater"
  s.license      = "MIT"
  s.authors      = "Hot Updater"
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }
  s.source_files = "ios/**/*.{h,m}"
  s.dependency "React-Core"
end
