# From examples/v0.85.0 after the native build installs gems:
# BUNDLE_PATH=vendor/bundle BUNDLE_FROZEN=1 \
#   bundle exec ruby ../../e2e/mobile/cocoapods-project.spec.rb
require 'cocoapods'
require 'fileutils'
require 'minitest/autorun'
require 'tmpdir'

OriginalProjectGroupMethod = Pod::Project.instance_method(:group_for_path_in_group)
require_relative '../../examples/v0.85.0/ios/cocoapods_pathname'

class CocoaPodsPathnameTest < Minitest::Test
  def setup
    @root = Pathname.new(Dir.mktmpdir('hot-updater-pod-path-')).realpath
    target = @root + 'store/package@1.0.0_with_a_long_pnpm_style_suffix_0123456789/node_modules/package'
    @link = @root + 'node_modules/package'
    FileUtils.mkdir_p(target + 'Sources/Nested')
    FileUtils.mkdir_p(@link.dirname)
    File.symlink(target.relative_path_from(@link.dirname), @link)
    @base = @link + 'Sources'
    @source = @base + 'Nested/Example.h'
    @source.write('// fixture')
    @project = Pod::Project.new(@root + 'Actual.xcodeproj')
    @reference = Pod::Project.new(@root + 'Reference.xcodeproj')
    @group = @project.new_group('Package', @link)
    @reference_group = @reference.new_group('Package', @link)
  end

  def teardown
    FileUtils.remove_entry(@root)
  end

  def test_relative_symlink_source_references_survive_garbage_collection
    expected_group = original_group(@source, true, @base.realpath)
    expected = expected_group.new_file(@source.realpath)
    actual = with_gc_stress do
      @project.add_file_reference(@source, @group, true, @base)
    end

    assert_equal expected.real_path, actual.real_path
    assert_equal expected.parent.real_path, actual.parent.real_path
    assert_equal expected.parent.hierarchy_path, actual.parent.hierarchy_path
    refute_includes actual.real_path.to_s, "\0"
    assert Pod::Project.private_method_defined?(:group_for_path_in_group)
  end

  def test_localized_interface_and_strings_share_a_variant_group
    resources = @link + 'Resources'
    xib = resources + 'Base.lproj/Main.xib'
    strings = resources + 'fr.lproj/Main.strings'
    [xib, strings].each do |file|
      FileUtils.mkdir_p(file.dirname)
      file.write('fixture')
    end

    interface_ref = @project.add_file_reference(xib, @group, true, resources)
    strings_ref = @project.add_file_reference(strings, @group, true, resources)

    assert_same interface_ref.parent, strings_ref.parent
    assert_instance_of Xcodeproj::Project::Object::PBXVariantGroup, interface_ref.parent
    assert_equal 'Main.xib', interface_ref.parent.name
    assert_equal [xib.realpath, strings.realpath].sort,
                 interface_ref.parent.children.map(&:real_path).sort
  end

  def test_nil_base_preserves_upstream_group_layout
    expected = original_group(@source, true, nil)
    actual = @project.send(:group_for_path_in_group, @source, @group, true, nil)
    assert_equal expected.real_path, actual.real_path
    assert_equal expected.hierarchy_path, actual.hierarchy_path
  end

  def test_disabled_file_structure_preserves_the_existing_group
    assert_same @reference_group, original_group(@source, false, @base.realpath)
    assert_same @group, @project.send(:group_for_path_in_group, @source, @group, false, @base)
  end

  def test_relative_base_is_still_rejected
    error = assert_raises(ArgumentError) do
      @project.send(:group_for_path_in_group, @source, @group, true, Pathname.new('Sources'))
    end
    assert_equal 'Paths must be absolute Sources', error.message
  end

  def test_missing_last_component_keeps_realdirpath_semantics
    missing = @base + 'NotGeneratedYet'
    source = missing + 'Generated.h'
    expected = original_group(source, true, missing)
    actual = @project.send(:group_for_path_in_group, source, @group, true, missing)
    assert_equal expected.real_path, actual.real_path
    assert_equal expected.hierarchy_path, actual.hierarchy_path
  end

  private

  def original_group(source, reflect, base)
    OriginalProjectGroupMethod.bind(@reference).call(source, @reference_group, reflect, base)
  end

  def with_gc_stress
    previous = GC.stress
    GC.stress = true
    yield
  ensure
    GC.stress = previous
  end
end
