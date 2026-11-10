# Ruby's realdirpath can corrupt relative symlink targets during GC.
# Resolve existing local pod roots with realpath before CocoaPods groups files.
# https://github.com/CocoaPods/CocoaPods/issues/12866
module CocoaPodsPathname
  private

  def group_for_path_in_group(absolute_pathname, group, reflect_file_system_structure, base_path = nil)
    base_path = base_path.realpath if base_path&.absolute? && base_path.exist?
    super(absolute_pathname, group, reflect_file_system_structure, base_path)
  end
end

Pod::Project.prepend(CocoaPodsPathname)
