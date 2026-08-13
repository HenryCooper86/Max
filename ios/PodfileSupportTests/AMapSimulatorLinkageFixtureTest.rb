#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "json"
require "minitest/autorun"
require "open3"
require "pathname"
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
  APP_DEVICE_FLAGS = '-ObjC -force_load "$(PODS_CONFIGURATION_BUILD_DIR)/UnrelatedSource/libUnrelatedSource.a" ' \
                     '-F"$(PODS_ROOT)/Device Frameworks" -L$(PODS_ROOT)/Library\\ With\\ Space ' \
                     '@"$(SRCROOT)/Args With Space.rsp" -framework "AMapFoundationKit" -framework MAMapKit ' \
                     '-framework Foundation -lobjc -framework AMapFoundationKit -framework MAMapKit'.freeze
  APP_SIMULATOR_FLAGS = '-ObjC -force_load "$(PODS_CONFIGURATION_BUILD_DIR)/UnrelatedSource/libUnrelatedSource.a" ' \
                        '-F"$(PODS_ROOT)/Device Frameworks" -L$(PODS_ROOT)/Library\\ With\\ Space ' \
                        '@"$(SRCROOT)/Args With Space.rsp" -framework Foundation -lobjc'.freeze
  TEST_DEVICE_FLAGS = '-ObjC -F"$(PODS_ROOT)/Device Frameworks" -L$(PODS_ROOT)/Library\\ With\\ Space ' \
                      '@"$(SRCROOT)/Args With Space.rsp" -framework Foundation -lobjc'.freeze
  FUTURE_UNRELATED_FLAG = '-framework FutureVendorKit'.freeze

  def setup
    flunk "AMap simulator linkage support is missing: #{AMAP_SIMULATOR_LINKAGE_LOAD_ERROR}" if defined?(AMAP_SIMULATOR_LINKAGE_LOAD_ERROR)
  end

  def test_real_cocoapods_fixture_preserves_unrelated_simulator_linkage_and_products
    Dir.mktmpdir("amap-simulator-linkage") do |directory|
      fixture = Pathname.new(directory)
      create_fixture(fixture)

      run_pod_install(fixture)
      assert_fixture(fixture, future_unrelated_flag: false, build: true)
      # Model a future Pod integration adding a linker input between installs.
      # The hook must use the freshly generated iPhoneOS flags rather than a
      # stale, previously filtered simulator value.
      run_pod_install(fixture, future_unrelated_flag: true)
      assert_fixture(fixture, future_unrelated_flag: true, build: false)
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

  def test_raw_filter_removes_only_exact_amap_framework_pairs_without_requoting_other_lexemes
    raw = '-ObjC -force_load "$(PODS_ROOT)/Pod With Space/libPod.a" -F"$(PODS_ROOT)/Framework With Space" ' \
          '-L$(PODS_ROOT)/Library\\ With\\ Space @"$(SRCROOT)/Args With Space.rsp" ' \
          '-framework "AMapFoundationKit" -framework MAMapKit -framework "Other Vendor" ' \
          '-l"Unrelated Archive" -framework AMapFoundationKit -force_load "$(PODS_ROOT)/Again/libAgain.a"'
    expected = '-ObjC -force_load "$(PODS_ROOT)/Pod With Space/libPod.a" -F"$(PODS_ROOT)/Framework With Space" ' \
               '-L$(PODS_ROOT)/Library\\ With\\ Space @"$(SRCROOT)/Args With Space.rsp" ' \
               '-framework "Other Vendor" -l"Unrelated Archive" -force_load "$(PODS_ROOT)/Again/libAgain.a"'

    assert_equal expected, AMapSimulatorLinkage.filter_amap_framework_pairs_raw(raw)
  end

  def test_raw_filter_fails_closed_for_a_framework_flag_without_a_name
    error = assert_raises(Pod::Informative) do
      AMapSimulatorLinkage.filter_amap_framework_pairs_raw('-ObjC -framework')
    end

    assert_includes error.message, "-framework"
  end

  def test_xcconfig_transform_keeps_device_flag_lexemes_and_filters_only_amap_for_simulator
    raw_flags = '-ObjC -force_load "$(PODS_ROOT)/Pod With Space/libPod.a" -F"$(PODS_ROOT)/Framework With Space" ' \
                '-L$(PODS_ROOT)/Library\\ With\\ Space @"$(SRCROOT)/Args With Space.rsp" ' \
                '-framework "AMapFoundationKit" -framework MAMapKit -framework "Other Vendor" -l"Unrelated Archive"'
    expected_simulator_flags = '-ObjC -force_load "$(PODS_ROOT)/Pod With Space/libPod.a" -F"$(PODS_ROOT)/Framework With Space" ' \
                               '-L$(PODS_ROOT)/Library\\ With\\ Space @"$(SRCROOT)/Args With Space.rsp" ' \
                               '-framework "Other Vendor" -l"Unrelated Archive"'
    input = "HEADER_SEARCH_PATHS = $(inherited) \"$(PODS_ROOT)/Headers\"\n" \
            "OTHER_LDFLAGS = #{raw_flags}\n" \
            "PODS_ROOT = ${SRCROOT}/Pods\n"
    expected = "HEADER_SEARCH_PATHS = $(inherited) \"$(PODS_ROOT)/Headers\"\n" \
               "AMAP_PLATFORM_OTHER_LDFLAGS[sdk=iphoneos*] = #{raw_flags}\n" \
               "AMAP_PLATFORM_OTHER_LDFLAGS[sdk=iphonesimulator*] = #{expected_simulator_flags}\n" \
               "OTHER_LDFLAGS = $(AMAP_PLATFORM_OTHER_LDFLAGS) $(inherited)\n" \
               "EXCLUDED_ARCHS[sdk=iphonesimulator*] = \n" \
               "PODS_ROOT = ${SRCROOT}/Pods\n"

    assert_equal expected, AMapSimulatorLinkage.transform_xcconfig_for_platform_linkage(input)
  end

  def test_unsafe_amap_provider_fails_before_mutating_generated_artifacts
    Dir.mktmpdir("amap-simulator-linkage-unsafe") do |directory|
      fixture = Pathname.new(directory)
      create_fixture(fixture)

      output, status = run_pod_install(fixture, unsafe_provider: true, assert_success: false)

      refute status.success?, output
      assert_includes output, "no-op"
      audit = JSON.parse((fixture / "atomic-hook-audit.json").read)
      assert_equal true, audit.fetch("unchanged")
    end
  end

  def test_missing_amap_device_flags_fail_before_mutating_generated_artifacts
    Dir.mktmpdir("amap-simulator-linkage-missing-flags") do |directory|
      fixture = Pathname.new(directory)
      create_fixture(fixture)

      output, status = run_pod_install(fixture, missing_amap_flags: true, assert_success: false)

      refute status.success?, output
      assert_includes output, "Expected direct iPhoneOS AMap framework linker settings"
      audit = JSON.parse((fixture / "atomic-hook-audit.json").read)
      assert_equal true, audit.fetch("unchanged")
    end
  end

  def test_missing_amap_provider_fails_before_mutating_generated_artifacts
    Dir.mktmpdir("amap-simulator-linkage-missing-provider") do |directory|
      fixture = Pathname.new(directory)
      create_fixture(fixture)

      output, status = run_pod_install(fixture, missing_provider: true, assert_success: false)

      refute status.success?, output
      assert_includes output, "Expected AMap provider target"
      audit = JSON.parse((fixture / "atomic-hook-audit.json").read)
      assert_equal true, audit.fetch("unchanged")
    end
  end

  def test_missing_amap_aggregate_product_fails_before_mutating_generated_artifacts
    Dir.mktmpdir("amap-simulator-linkage-missing-product") do |directory|
      fixture = Pathname.new(directory)
      create_fixture(fixture)

      output, status = run_pod_install(fixture, missing_aggregate_product: true, assert_success: false)

      refute status.success?, output
      assert_includes output, "Expected product reference"
      audit = JSON.parse((fixture / "atomic-hook-audit.json").read)
      assert_equal true, audit.fetch("unchanged")
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
    create_device_frameworks(root)
    FileUtils.mkdir_p(root / "Pods/Library With Space")
    (root / "Args With Space.rsp").write("")

    app_flags = APP_DEVICE_FLAGS
    test_flags = TEST_DEVICE_FLAGS

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
        aggregate.dependencies.select { |dependency| ["AMap3DMap-NO-IDFA", "AMapFoundation-NO-IDFA"].include?(dependency.display_name) }
                 .each(&:remove_from_project)
        provider_names = ["AMap3DMap-NO-IDFA", "AMapFoundation-NO-IDFA"]
        provider_names.each do |name|
          original = installer.pods_project.targets.find { |target| target.name == name }
          original.remove_from_project
        end
        provider_names.delete("AMapFoundation-NO-IDFA") if ENV["FIXTURE_MISSING_PROVIDER"] == "1"
        provider_targets = provider_names.to_h do |name|
          replacement = installer.pods_project.new_aggregate_target(name)
          [name, replacement]
        end
        if provider_targets.key?("AMapFoundation-NO-IDFA")
          provider_targets.fetch("AMap3DMap-NO-IDFA").add_dependency(provider_targets.fetch("AMapFoundation-NO-IDFA"))
        end
        provider_targets.each_value { |target| aggregate.add_dependency(target) }
        aggregate.product_reference = nil if ENV["FIXTURE_MISSING_AGGREGATE_PRODUCT"] == "1"
        app_flags = #{app_flags.inspect}
        test_flags = #{test_flags.inspect}
        app_flags = test_flags if ENV["FIXTURE_MISSING_AMAP_FLAGS"] == "1"
        installer.aggregate_targets.each do |target|
          flags = target.label == "Pods-FixtureApp" ? app_flags : test_flags
          flags = "#{'#{flags}'} #{'#{ENV["FIXTURE_FUTURE_UNRELATED_FLAG"] == "1" ? "-framework FutureVendorKit" : ""}'}".strip
          target.xcconfigs.each_key do |configuration|
            path = target.client_root + target.xcconfig_relative_path(configuration)
            content = File.binread(path)
            content.sub!(/^OTHER_LDFLAGS\\s*=.*$/, "OTHER_LDFLAGS = #{'#{flags}'}")
            File.binwrite(path, content)
          end
        end
        if ENV["FIXTURE_UNSAFE_PROVIDER"] == "1"
          installer.pods_project.targets.find { |target| target.name == "AMap3DMap-NO-IDFA" }.new_shell_script_build_phase("Unsafe AMap fixture work")
        end
        before = {
          "project" => File.binread(installer.pods_project.path + "project.pbxproj"),
          "xcconfigs" => installer.aggregate_targets.flat_map do |target|
            target.xcconfigs.keys.map do |configuration|
              path = target.client_root + target.xcconfig_relative_path(configuration)
              [path.to_s, File.binread(path)]
            end
          end.to_h
        }
        begin
          AMapSimulatorLinkage.apply(installer)
        rescue Pod::Informative => error
          after = {
            "project" => File.binread(installer.pods_project.path + "project.pbxproj"),
            "xcconfigs" => before.fetch("xcconfigs").keys.to_h { |path| [path, File.binread(path)] }
          }
          File.write("atomic-hook-audit.json", JSON.generate("unchanged" => before == after, "error" => error.message))
          raise
        end
      end
    RUBY
  end

  def create_project(path)
    project = Xcodeproj::Project.new(path)
    app = project.new_target(:application, "FixtureApp", :ios, "17.0")
    tests = project.new_target(:unit_test_bundle, "FixtureTests", :ios, "17.0")
    tests.add_dependency(app)
    source = path.dirname / "FixtureApp.m"
    source.write <<~OBJC
      extern void unrelated_fixture_symbol(void);
      int main(void) {
        unrelated_fixture_symbol();
        return 0;
      }
    OBJC
    app.add_file_references([project.new_file(source)])
    project.targets.each do |target|
      target.build_configurations.each do |configuration|
        configuration.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "invalid.fixture.#{target.name.downcase}"
        configuration.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
      end
    end
    project.save
  end

  def create_device_frameworks(root)
    source = root / "FixtureFramework.c"
    source.write("void fixture_framework_symbol(void) {}\n")
    frameworks_root = root / "Pods/Device Frameworks"
    FileUtils.mkdir_p(frameworks_root)
    %w[AMapFoundationKit MAMapKit].each do |framework|
      framework_root = frameworks_root / "#{framework}.framework"
      FileUtils.mkdir_p(framework_root / "Headers")
      object = framework_root / "fixture.o"
      binary = framework_root / framework
      output, status = Open3.capture2e(
        "xcrun", "--sdk", "iphoneos", "clang", "-target", "arm64-apple-ios17.0",
        "-c", source.to_s, "-o", object.to_s
      )
      raise output unless status.success?
      output, status = Open3.capture2e("xcrun", "--sdk", "iphoneos", "libtool", "-static", "-o", binary.to_s, object.to_s)
      raise output unless status.success?
      (framework_root / "Info.plist").write("<plist version=\"1.0\"><dict/></plist>\n")
    end
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
    FileUtils.mkdir_p(pod_root / "Resources")
    (pod_root / "Sources/UnrelatedSource.m").write("void unrelated_fixture_symbol(void) {}\n")
    (pod_root / "Resources/FixtureResource.txt").write("retained resource\n")
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
        s.resources = "Resources/*.txt"
      end
    RUBY
  end

  def run_pod_install(root, future_unrelated_flag: false, unsafe_provider: false, missing_amap_flags: false,
                      missing_provider: false, missing_aggregate_product: false, assert_success: true)
    output, status = Open3.capture2e(
      {
        "BUNDLE_GEMFILE" => (IOS_ROOT / "Gemfile").to_s,
        "FIXTURE_FUTURE_UNRELATED_FLAG" => future_unrelated_flag ? "1" : "0",
        "FIXTURE_UNSAFE_PROVIDER" => unsafe_provider ? "1" : "0",
        "FIXTURE_MISSING_AMAP_FLAGS" => missing_amap_flags ? "1" : "0",
        "FIXTURE_MISSING_PROVIDER" => missing_provider ? "1" : "0",
        "FIXTURE_MISSING_AGGREGATE_PRODUCT" => missing_aggregate_product ? "1" : "0"
      },
      "bundle", "exec", "pod", "install",
      chdir: root.to_s
    )
    assert status.success?, output if assert_success
    [output, status]
  end

  def assert_fixture(root, future_unrelated_flag:, build:)
    suffix = future_unrelated_flag ? " #{FUTURE_UNRELATED_FLAG}" : ""
    expected_app_device = "#{APP_DEVICE_FLAGS}#{suffix}"
    expected_app_simulator = "#{APP_SIMULATOR_FLAGS}#{suffix}"
    expected_test_device = "#{TEST_DEVICE_FLAGS}#{suffix}"

    %w[debug release].each do |configuration|
      assert_raw_platform_linkage(
        root, "Pods-FixtureApp", configuration,
        device: expected_app_device,
        simulator: expected_app_simulator
      )
      assert_raw_platform_linkage(
        root, "Pods-FixtureTests", configuration,
        device: expected_test_device,
        simulator: expected_test_device
      )
    end

    %w[Debug Release].each do |configuration|
      assert_evaluated_other_ldflags(
        root, target: "FixtureApp", configuration: configuration, sdk: "iphonesimulator",
        expected_raw: expected_app_simulator
      )
      assert_evaluated_other_ldflags(
        root, target: "FixtureApp", configuration: configuration, sdk: "iphoneos",
        expected_raw: expected_app_device
      )
      assert_evaluated_other_ldflags(
        root, target: "FixtureTests", configuration: configuration, sdk: "iphonesimulator",
        expected_raw: expected_test_device
      )
      assert_evaluated_other_ldflags(
        root, target: "FixtureTests", configuration: configuration, sdk: "iphoneos",
        expected_raw: expected_test_device
      )
    end
    build_fixture(root) if build

    # These are deliberately handwritten mutation oracles, independent of
    # production filtering logic.
    assert_raises(Minitest::Assertion) { assert_equal expected_app_simulator, expected_app_simulator.sub("-framework Foundation", "") }
    assert_raises(Minitest::Assertion) { assert_equal expected_app_simulator, "#{expected_app_simulator} -framework MAMapKit" }

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
    resource_script = root / "Pods/Target Support Files/Pods-FixtureApp/Pods-FixtureApp-resources.sh"
    assert_includes resource_script.read, "FixtureResource.txt"
  end

  def raw_config(root, aggregate, configuration)
    path = root / "Pods/Target Support Files/#{aggregate}/#{aggregate}.#{configuration}.xcconfig"
    File.binread(path)
  end

  def assert_raw_platform_linkage(root, aggregate, configuration, device:, simulator:)
    settings = raw_config(root, aggregate, configuration).lines.to_h do |line|
      key, value = AMapSimulatorLinkage.raw_xcconfig_setting(line)
      [key, value] if key
    end
    assert_equal device, settings.fetch("AMAP_PLATFORM_OTHER_LDFLAGS[sdk=iphoneos*]")
    assert_equal simulator, settings.fetch("AMAP_PLATFORM_OTHER_LDFLAGS[sdk=iphonesimulator*]")
    assert_equal "$(AMAP_PLATFORM_OTHER_LDFLAGS) $(inherited)", settings.fetch("OTHER_LDFLAGS")
    assert_equal "", settings.fetch("EXCLUDED_ARCHS[sdk=iphonesimulator*]")
  end

  def assert_evaluated_other_ldflags(root, target:, configuration:, sdk:, expected_raw:)
    output, status = Open3.capture2e(
      { "DEVELOPER_DIR" => "/Applications/Xcode.app/Contents/Developer" },
      "xcodebuild", "-showBuildSettings", "-project", "Fixture.xcodeproj", "-target", target,
      "-configuration", configuration, "-sdk", sdk,
      chdir: root.to_s
    )
    assert status.success?, output
    settings = output.lines.filter_map do |line|
      match = line.match(/^\s{4}([A-Z0-9_]+) = (.*)$/)
      [match[1], match[2].strip] if match
    end.to_h
    expected = expected_raw
               .gsub("$(PODS_CONFIGURATION_BUILD_DIR)", settings.fetch("PODS_CONFIGURATION_BUILD_DIR"))
               .gsub("$(PODS_ROOT)", settings.fetch("PODS_ROOT"))
               .gsub("$(SRCROOT)", settings.fetch("SRCROOT"))
    assert_equal expected, settings.fetch("OTHER_LDFLAGS")
  end

  def build_fixture(root)
    %w[Debug Release].product(%w[iphonesimulator iphoneos]).each do |configuration, sdk|
      output, status = Open3.capture2e(
        { "DEVELOPER_DIR" => "/Applications/Xcode.app/Contents/Developer" },
        "xcodebuild", "clean", "build", "-workspace", "Fixture.xcworkspace", "-scheme", "FixtureApp",
        "-configuration", configuration, "-sdk", sdk, "-destination",
        sdk == "iphoneos" ? "generic/platform=iOS" : "generic/platform=iOS Simulator",
        "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=",
        chdir: root.to_s
      )
      assert status.success?, output
    end
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
