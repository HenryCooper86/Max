# frozen_string_literal: true

require "cocoapods"
require "shellwords"
require "xcodeproj"

module AMapSimulatorLinkage
  AMAP_POD_NAMES = ["AMap3DMap-NO-IDFA", "AMapFoundation-NO-IDFA"].freeze
  AMAP_FRAMEWORKS = ["AMapFoundationKit", "MAMapKit"].freeze
  SIMULATOR_SDK = "sdk=iphonesimulator*"
  DEVICE_SDK = "sdk=iphoneos*"
  PLATFORM_OTHER_LDFLAGS = "AMAP_PLATFORM_OTHER_LDFLAGS"

  module_function

  def apply(installer)
    pod_projects_to_save = {}
    xcconfigs_to_save = {}
    amap_provider_count = 0
    configured_provider_labels = {}

    installer.aggregate_targets.each do |aggregate_target|
      related_targets = transitive_search_path_targets(aggregate_target)
      amap_provider_targets = related_targets.select do |target|
        contains_amap_pod?(target.pod_targets)
      end
      next if amap_provider_targets.empty?

      amap_provider_count += amap_provider_targets.count
      amap_provider_targets.each do |provider_target|
        next if configured_provider_labels[provider_target.label]

        configure_provider!(provider_target, installer.pods_project, pod_projects_to_save)
        configured_provider_labels[provider_target.label] = true
      end

      related_targets.each do |target|
        configure_simulator_xcconfigs!(target, xcconfigs_to_save)
      end
    end

    if amap_provider_count.zero?
      raise Pod::Informative,
            "No CocoaPods aggregate target contains AMap; simulator linkage cleanup was not applied."
    end

    xcconfigs_to_save.each do |path, xcconfig|
      xcconfig.save_as(path)
    end
    pod_projects_to_save.each_value(&:save)
  end

  def filter_amap_framework_flags(flags)
    tokens = flags.is_a?(String) ? Shellwords.shellsplit(flags) : flags.dup
    filtered = []
    index = 0
    while index < tokens.length
      if tokens[index] == "-framework" && AMAP_FRAMEWORKS.include?(tokens[index + 1])
        index += 2
      else
        filtered << tokens[index]
        index += 1
      end
    end
    filtered
  end

  def validate_aggregate_product!(aggregate_target, pods_project)
    pods_target = pods_project.targets.find { |target| target.name == aggregate_target.label }
    unless pods_target
      raise Pod::Informative,
            "Expected CocoaPods native target #{aggregate_target.label} for AMap simulator linkage cleanup."
    end

    product_reference = pods_target.respond_to?(:product_reference) && pods_target.product_reference
    unless product_reference
      raise Pod::Informative,
            "Expected product reference for AMap aggregate #{aggregate_target.label}; " \
            "cannot establish simulator-safe cleanup."
    end

    unless product_reference.path&.end_with?(".a")
      raise Pod::Informative,
            "Unexpected AMap aggregate product #{product_reference.path.inspect} for #{aggregate_target.label}; " \
            "only a static Pods archive is supported by simulator linkage cleanup."
    end

    pods_target
  end

  def transitive_search_path_targets(aggregate_target)
    targets = []
    pending_targets = [aggregate_target]
    seen_labels = {}
    until pending_targets.empty?
      target = pending_targets.shift
      next if seen_labels[target.label]

      seen_labels[target.label] = true
      targets << target
      pending_targets.concat(target.search_paths_aggregate_targets)
    end
    targets
  end

  def contains_amap_pod?(pod_targets)
    pod_targets.any? do |pod_target|
      ([pod_target] + pod_target.recursive_dependent_targets).any? do |candidate|
        AMAP_POD_NAMES.include?(candidate.pod_name)
      end
    end
  end

  def configure_provider!(aggregate_target, pods_project, projects_to_save)
    aggregate_native_target = validate_aggregate_product!(aggregate_target, pods_project)
    amap_labels = amap_pod_target_labels(aggregate_target)
    dependencies_by_name = aggregate_native_target.dependencies.group_by(&:display_name)
    missing_dependencies = amap_labels.reject { |label| dependencies_by_name.key?(label) }
    unless missing_dependencies.empty?
      raise Pod::Informative,
            "Expected AMap target dependencies #{missing_dependencies.join(", ")} on #{aggregate_target.label}; " \
            "found #{aggregate_native_target.dependencies.map(&:display_name).join(", ").inspect}; " \
            "Pods targets #{pods_project.targets.map(&:name).grep(/AMap/).join(", ").inspect}; " \
            "cannot establish simulator-safe cleanup."
    end

    aggregate_native_target.dependencies.dup.each do |dependency|
      dependency.remove_from_project if amap_labels.include?(dependency.display_name)
    end
    projects_to_save[pods_project.path] = pods_project
  end

  def amap_pod_target_labels(aggregate_target)
    aggregate_target.pod_targets.flat_map do |pod_target|
      ([pod_target] + pod_target.recursive_dependent_targets)
    end.select { |pod_target| AMAP_POD_NAMES.include?(pod_target.pod_name) }.map(&:label).uniq
  end

  def configure_simulator_xcconfigs!(aggregate_target, xcconfigs_to_save)
    aggregate_target.xcconfigs.each do |configuration_name, xcconfig|
      # On a repeated `pod install`, the normal setting deliberately contains
      # only our platform macro.  Its persisted iPhoneOS value is therefore
      # the source of truth for the direct-link safety check and the next
      # simulator derivation.  Before the first rewrite, fall back to the
      # CocoaPods-generated unqualified linker flags.
      device_flags = xcconfig.attributes.fetch(
        "#{PLATFORM_OTHER_LDFLAGS}[#{DEVICE_SDK}]",
        xcconfig.to_hash.fetch("OTHER_LDFLAGS", "")
      )
      if contains_amap_pod?(aggregate_target.pod_targets)
        missing_frameworks = AMAP_FRAMEWORKS.reject do |framework|
          Shellwords.shellsplit(device_flags).each_cons(2).any? do |pair|
            pair == ["-framework", framework]
          end
        end
        unless missing_frameworks.empty?
          raise Pod::Informative,
                "Expected direct iPhoneOS AMap framework linker settings #{missing_frameworks.join(", ")} " \
                "for #{aggregate_target.label}; found #{device_flags.inspect}; refusing simulator cleanup."
        end
      end

      # Xcodeproj parses OTHER_LDFLAGS into a dedicated collection and uses
      # that collection when serializing.  Mutating `attributes` alone would
      # leave the original (unqualified) AMap flags in the saved xcconfig.
      # Keep the normal setting limited to the platform switch, then retain
      # the resolved device flags and their exact simulator-filtered sequence
      # in conditional settings below.
      xcconfig.other_linker_flags.each_value(&:clear)
      xcconfig.other_linker_flags[:simple] << "$(inherited)"
      xcconfig.other_linker_flags[:simple] << "$(#{PLATFORM_OTHER_LDFLAGS})"
      xcconfig.attributes["#{PLATFORM_OTHER_LDFLAGS}[#{DEVICE_SDK}]"] = without_inherited_flag(device_flags).join(" ")
      xcconfig.attributes["#{PLATFORM_OTHER_LDFLAGS}[#{SIMULATOR_SDK}]"] =
        without_inherited_flag(filter_amap_framework_flags(device_flags)).join(" ")
      xcconfig.attributes["EXCLUDED_ARCHS[#{SIMULATOR_SDK}]"] = ""
      path = aggregate_target.client_root + aggregate_target.xcconfig_relative_path(configuration_name)
      xcconfigs_to_save[path] = xcconfig
    end
  end

  def without_inherited_flag(flags)
    tokens = flags.is_a?(String) ? Shellwords.shellsplit(flags) : flags.dup
    tokens.reject { |token| ["$(inherited)", "${inherited}"].include?(token) }
  end
end
