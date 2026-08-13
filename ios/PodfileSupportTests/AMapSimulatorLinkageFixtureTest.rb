#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "minitest/autorun"
require "open3"
require "pathname"
require "shellwords"
require "tmpdir"
require "xcodeproj"
require "cocoapods"

IOS_ROOT = Pathname.new(__dir__).parent
begin
  require_relative "../PodfileSupport/amap_simulator_linkage"
rescue LoadError => error
  AMAP_SIMULATOR_LINKAGE_LOAD_ERROR = error
end

class AMapSimulatorLinkageFixtureTest < Minitest::Test
  AMAP_FRAMEWORKS = %w(AMapFoundationKit MAMapKit).freeze

  def setup
    flunk "AMap simulator linkage support is missing: #{AMAP_SIMULATOR_LINKAGE_LOAD_ERROR}" if defined?(AMAP_SIMULATOR_LINKAGE_LOAD_ERROR)
  end

  def test_real_cocoapods_fixture_preserves_unrelated_simulator_linkage_and_products
    Dir.mktmpdir("amap-simulator-linkage") do |directory|
      fixture = Pathname.new(directory)
      create_fixture(fixture)

      run_pod_install(fixture)
      assert_fixture(fixture, future_unrelated_flag: false)
      # Model a future Pod integration adding a linker input between installs.
      # The hook must use the freshly generated iPhoneOS flags rather than a
      # stale, previously filtered simulator value.
      run_pod_install(fixture, future_unrelated_flag: true)
      assert_fixture(fixture, future_unrelated_flag: true)
    end
  end

  def test_missing_or_unexpected_amap_aggregate_product_fails_closed
    aggregate = Struct.new(:label).new("Pods-FixtureApp")
    product = Struct.new(:path)
    target = Struct.new(:name, :product_reference)
    project = Struct.new(:targets)

    assert_raises(Pod::Informative) do
      AMapSimulatorLinkage.validate_aggregate_product!(aggregate, project.new([]))
    end
    assert_raises(Pod::Informative) do
      AMapSimulatorLinkage.validate_aggregate_product!(aggregate, project.new([target.new(aggregate.label, nil)]))
    end
    assert_raises(Pod::Informative) do
      AMapSimulatorLinkage.validate_aggregate_product!(
        aggregate,
        project.new([target.new(aggregate.label, product.new("Pods-FixtureApp.framework"))])
      )
    end
  end

  private

  def create_fixture(root)
    FileUtils.mkdir_p(root)
    create_project(root / "Fixture.xcodeproj")
    create_source_framework_pod(root, "AMapFoundation-NO-IDFA", "AMapFoundationKit")
    create_source_framework_pod(root, "AMap3DMap-NO-IDFA", "MAMapKit", dependency: "AMapFoundation-NO-IDFA")
    create_source_pod(root)
    create_vendored_pod(root, "UnrelatedVendored", "OtherVendor")

    support_path = IOS_ROOT / "PodfileSupport/amap_simulator_linkage"
    (root / "Podfile").write <<~RUBY
      platform :ios, "17.0"
      project "Fixture.xcodeproj"

      target "FixtureApp" do
        pod "AMap3DMap-NO-IDFA", :path => "PodSources/AMap3DMap-NO-IDFA"
        pod "AMapFoundation-NO-IDFA", :path => "PodSources/AMapFoundation-NO-IDFA"
        pod "UnrelatedSource", :path => "PodSources/UnrelatedSource"
        pod "UnrelatedVendored", :path => "PodSources/UnrelatedVendored"

        target "FixtureTests" do
          inherit! :search_paths
        end
      end

      require #{support_path.to_s.inspect}
      post_integrate do |installer|
        # CocoaPods treats the local fake frameworks as direct linker inputs,
        # while the production AMap SDK supplies aggregate target dependencies.
        # Mirror that production metadata here so the fixture exercises the
        # dependency-removal branch against a real generated Pods project.
        aggregate = installer.pods_project.targets.find { |target| target.name == "Pods-FixtureApp" }
        ["AMap3DMap-NO-IDFA", "AMapFoundation-NO-IDFA"].each do |name|
          aggregate.add_dependency(installer.pods_project.targets.find { |target| target.name == name })
        end
        installer.aggregate_targets.find { |target| target.label == "Pods-FixtureApp" }.xcconfigs.each_value do |xcconfig|
          xcconfig.other_linker_flags[:frameworks] << "AMapFoundationKit"
          xcconfig.other_linker_flags[:frameworks] << "MAMapKit"
          xcconfig.other_linker_flags[:frameworks] << "FutureVendorKit" if ENV["FIXTURE_FUTURE_UNRELATED_FLAG"] == "1"
        end
        AMapSimulatorLinkage.apply(installer)
      end
    RUBY
  end

  def create_project(path)
    project = Xcodeproj::Project.new(path)
    app = project.new_target(:application, "FixtureApp", :ios, "17.0")
    tests = project.new_target(:unit_test_bundle, "FixtureTests", :ios, "17.0")
    tests.add_dependency(app)
    project.save
  end

  def create_vendored_pod(root, name, framework, dependency: nil)
    pod_root = root / "PodSources" / name
    framework_root = pod_root / "#{framework}.framework"
    FileUtils.mkdir_p(framework_root / "Headers")
    FileUtils.mkdir_p(pod_root / "Sources")
    (framework_root / "Info.plist").write("<plist version=\"1.0\"><dict/></plist>\n")
    (pod_root / "Sources/#{name}.m").write("void #{name.gsub(/[^A-Za-z]/, "_")}_fixture_symbol(void) {}\n")
    dependency_line = dependency ? "s.dependency #{dependency.inspect}\n" : ""
    (pod_root / "#{name}.podspec").write <<~RUBY
      Pod::Spec.new do |s|
        s.name = #{name.inspect}
        s.version = "1.0.0"
        s.summary = "Fixture #{name}"
        s.homepage = "https://example.invalid/#{name}"
        s.license = { :type => "MIT" }
        s.author = "Fixture"
        s.platform = :ios, "17.0"
        s.source = { :path => "." }
        s.source_files = "Sources/**/*.{m,h}"
        s.vendored_frameworks = "#{framework}.framework"
        #{dependency_line.rstrip}
      end
    RUBY
  end

  def create_source_framework_pod(root, name, framework, dependency: nil)
    pod_root = root / "PodSources" / name
    FileUtils.mkdir_p(pod_root / "Sources")
    (pod_root / "Sources/#{name}.m").write("void #{name.gsub(/[^A-Za-z]/, "_")}_fixture_symbol(void) {}\n")
    dependency_line = dependency ? "s.dependency #{dependency.inspect}\n" : ""
    (pod_root / "#{name}.podspec").write <<~RUBY
      Pod::Spec.new do |s|
        s.name = #{name.inspect}
        s.version = "1.0.0"
        s.summary = "Fixture #{name}"
        s.homepage = "https://example.invalid/#{name}"
        s.license = { :type => "MIT" }
        s.author = "Fixture"
        s.platform = :ios, "17.0"
        s.source = { :path => "." }
        s.source_files = "Sources/**/*.{m,h}"
        s.frameworks = #{framework.inspect}
        # The production binary pods export their framework flags directly to
        # the user aggregate xcconfig. Model that contract explicitly: local
        # source-only doubles otherwise have no vendor linker input to filter.
        s.user_target_xcconfig = { "OTHER_LDFLAGS" => "-framework #{framework}" }
        #{dependency_line.rstrip}
      end
    RUBY
  end

  def create_source_pod(root)
    pod_root = root / "PodSources/UnrelatedSource"
    FileUtils.mkdir_p(pod_root / "Sources")
    (pod_root / "Sources/UnrelatedSource.m").write("void unrelated_fixture_symbol(void) {}\n")
    (pod_root / "UnrelatedSource.podspec").write <<~RUBY
      Pod::Spec.new do |s|
        s.name = "UnrelatedSource"
        s.version = "1.0.0"
        s.summary = "Fixture source pod"
        s.homepage = "https://example.invalid/UnrelatedSource"
        s.license = { :type => "MIT" }
        s.author = "Fixture"
        s.platform = :ios, "17.0"
        s.source = { :path => "." }
        s.source_files = "Sources/**/*.{m,h}"
      end
    RUBY
  end

  def run_pod_install(root, future_unrelated_flag: false)
    output, status = Open3.capture2e(
      {
        "BUNDLE_GEMFILE" => (IOS_ROOT / "Gemfile").to_s,
        "FIXTURE_FUTURE_UNRELATED_FLAG" => future_unrelated_flag ? "1" : "0"
      },
      "bundle", "exec", "pod", "install",
      chdir: root.to_s
    )
    assert status.success?, output
  end

  def assert_fixture(root, future_unrelated_flag:)
    app_config = config(root, "Pods-FixtureApp", "debug")
    test_config = config(root, "Pods-FixtureTests", "debug")
    device_setting = "AMAP_PLATFORM_OTHER_LDFLAGS[sdk=iphoneos*]"
    simulator_setting = "AMAP_PLATFORM_OTHER_LDFLAGS[sdk=iphonesimulator*]"
    assert app_config.key?(device_setting)
    assert app_config.key?(simulator_setting)
    device_flags = tokens(app_config.fetch(device_setting))
    simulator_flags = tokens(app_config.fetch(simulator_setting))
    expected_simulator_flags = AMapSimulatorLinkage.filter_amap_framework_flags(device_flags)

    # The normal setting must contain no resolved, unqualified SDK flags.
    # The platform-specific macro is the only source for those flags.
    assert_equal ["$(AMAP_PLATFORM_OTHER_LDFLAGS)", "$(inherited)"],
                 tokens(app_config.fetch("OTHER_LDFLAGS")).sort
    assert_equal expected_simulator_flags, simulator_flags
    AMAP_FRAMEWORKS.each { |framework| refute_includes simulator_flags, framework }
    assert_includes device_flags, "AMapFoundationKit"
    assert_includes device_flags, "MAMapKit"
    assert_includes simulator_flags, "OtherVendor"
    if future_unrelated_flag
      assert_includes device_flags, "FutureVendorKit"
      assert_includes simulator_flags, "FutureVendorKit"
    else
      refute_includes device_flags, "FutureVendorKit"
      refute_includes simulator_flags, "FutureVendorKit"
    end
    assert_equal "", app_config.fetch("EXCLUDED_ARCHS[sdk=iphonesimulator*]")
    assert_equal "", test_config.fetch("EXCLUDED_ARCHS[sdk=iphonesimulator*]")

    # These assertions are deliberate mutation checks: dropping either
    # unrelated linker input or reintroducing either AMap framework diverges
    # from the exact, order-preserving expected simulator flags.
    assert_raises(Minitest::Assertion) { assert_equal expected_simulator_flags, simulator_flags - ["OtherVendor"] }
    assert_raises(Minitest::Assertion) { assert_equal expected_simulator_flags, simulator_flags + ["MAMapKit"] }

    pods_project = Xcodeproj::Project.open(root / "Pods/Pods.xcodeproj")
    app_pods_target = target_named(pods_project, "Pods-FixtureApp")
    test_pods_target = target_named(pods_project, "Pods-FixtureTests")
    assert_includes dependency_names(app_pods_target), "UnrelatedSource"
    refute_includes dependency_names(app_pods_target), "AMap3DMap-NO-IDFA"
    refute_includes dependency_names(app_pods_target), "AMapFoundation-NO-IDFA"
    assert_includes dependency_names(test_pods_target), "Pods-FixtureApp"

    user_project = Xcodeproj::Project.open(root / "Fixture.xcodeproj")
    assert_includes framework_paths(target_named(user_project, "FixtureApp")), "libPods-FixtureApp.a"
    assert_includes framework_paths(target_named(user_project, "FixtureTests")), "libPods-FixtureTests.a"
  end

  def config(root, aggregate, configuration)
    path = root / "Pods/Target Support Files/#{aggregate}/#{aggregate}.#{configuration}.xcconfig"
    Xcodeproj::Config.new(path).to_hash
  end

  def tokens(flags)
    Shellwords.shellsplit(flags)
  end

  def target_named(project, name)
    project.targets.find { |target| target.name == name } || flunk("Missing target #{name}")
  end

  def dependency_names(target)
    target.dependencies.map { |dependency| dependency.target&.name || dependency.name }
  end

  def framework_paths(target)
    target.frameworks_build_phase.files.map { |file| file.file_ref&.path }.compact
  end
end
