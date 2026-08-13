# frozen_string_literal: true

require "cocoapods"
require "xcodeproj"

module AMapSimulatorLinkage
  AMAP_POD_NAMES = ["AMap3DMap-NO-IDFA", "AMapFoundation-NO-IDFA"].freeze
  AMAP_FRAMEWORKS = ["AMapFoundationKit", "MAMapKit"].freeze
  SIMULATOR_SDK = "sdk=iphonesimulator*"
  DEVICE_SDK = "sdk=iphoneos*"
  PLATFORM_OTHER_LDFLAGS = "AMAP_PLATFORM_OTHER_LDFLAGS"
  RawFlagToken = Struct.new(:leading, :raw, :value, keyword_init: true)
  ProviderPlan = Struct.new(:pods_project, :dependencies, keyword_init: true)
  XcconfigPlan = Struct.new(:path, :content, keyword_init: true)

  module_function

  def apply(installer)
    provider_targets = {}
    config_targets = {}

    installer.aggregate_targets.each do |aggregate_target|
      related_targets = transitive_search_path_targets(aggregate_target)
      amap_provider_targets = related_targets.select do |target|
        contains_amap_pod?(target.pod_targets)
      end
      next if amap_provider_targets.empty?

      amap_provider_targets.each do |provider_target|
        provider_targets[provider_target.label] ||= provider_target
      end

      related_targets.each do |target|
        entry = config_targets[target.label] ||= { target: target, requires_amap: false }
        entry[:requires_amap] ||= contains_amap_pod?(target.pod_targets)
      end
    end

    if provider_targets.empty?
      raise Pod::Informative,
            "No CocoaPods aggregate target contains AMap; simulator linkage cleanup was not applied."
    end

    # Phase one: every provider/product/topology/configuration must validate
    # before a dependency or generated xcconfig is changed on disk.
    provider_plans = provider_targets.values.map do |provider_target|
      build_provider_plan(provider_target, installer.pods_project)
    end
    xcconfig_plans = config_targets.values.flat_map do |entry|
      build_xcconfig_plans(entry.fetch(:target), requires_amap: entry.fetch(:requires_amap))
    end

    # Phase two: apply only the fully prepared plan.
    xcconfig_plans.each { |plan| File.binwrite(plan.path, plan.content) }
    provider_plans.each do |plan|
      plan.dependencies.each(&:remove_from_project)
      plan.pods_project.save
    end
  end

  # Filters only the exact AMap `-framework NAME` token pairs. Every retained
  # lexeme is copied from the input rather than re-serialized, so quoting,
  # escapes, and Xcode build-setting macros retain their original spelling.
  def filter_amap_framework_pairs_raw(flags)
    tokens = lex_raw_linker_flags(flags)
    output = +""
    index = 0
    while index < tokens.length
      token = tokens[index]
      if token.value == "-framework"
        framework_name = tokens[index + 1]&.value
        unless framework_name && !framework_name.empty?
          raise Pod::Informative, "Malformed OTHER_LDFLAGS: -framework has no framework name."
        end
        if AMAP_FRAMEWORKS.include?(framework_name)
          index += 2
          next
        end
      end

      output << token.leading
      output << token.raw
      index += 1
    end
    output
  end

  def lex_raw_linker_flags(flags)
    tokens = []
    index = 0
    while index < flags.length
      leading_start = index
      index += 1 while index < flags.length && flags[index].match?(/\s/)
      leading = flags[leading_start...index]
      break if index == flags.length

      raw_start = index
      value = +""
      quote = nil
      until index == flags.length || (!quote && flags[index].match?(/\s/))
        character = flags[index]
        if character == "\\"
          raise Pod::Informative, "Malformed OTHER_LDFLAGS: dangling escape." if index + 1 == flags.length

          value << flags[index + 1]
          index += 2
        elsif quote
          if character == quote
            quote = nil
          else
            value << character
          end
          index += 1
        elsif character == '"' || character == "'"
          quote = character
          index += 1
        else
          value << character
          index += 1
        end
      end
      raise Pod::Informative, "Malformed OTHER_LDFLAGS: unterminated quote." if quote

      tokens << RawFlagToken.new(leading: leading, raw: flags[raw_start...index], value: value)
    end
    tokens
  end

  # Rewrites only linkage settings inside a generated CocoaPods xcconfig. The
  # device value is copied as raw text and the simulator value is derived by
  # removing exact AMap framework-pair lexemes. All unrelated xcconfig lines
  # and all retained linker lexemes are left byte-for-byte intact.
  def transform_xcconfig_for_platform_linkage(content)
    line_ending = content.include?("\r\n") ? "\r\n" : "\n"
    relevant_keys = platform_linkage_keys
    settings = platform_linkage_settings(content)
    device_flags = device_flags_from_platform_linkage_settings(settings)
    unless device_flags
      raise Pod::Informative, "Expected OTHER_LDFLAGS in generated xcconfig; refusing simulator cleanup."
    end
    simulator_flags = filter_amap_framework_pairs_raw(device_flags)
    replacement = [
      "#{PLATFORM_OTHER_LDFLAGS}[#{DEVICE_SDK}] = #{device_flags}",
      "#{PLATFORM_OTHER_LDFLAGS}[#{SIMULATOR_SDK}] = #{simulator_flags}",
      "OTHER_LDFLAGS = $(#{PLATFORM_OTHER_LDFLAGS}) $(inherited)",
      "EXCLUDED_ARCHS[#{SIMULATOR_SDK}] = "
    ].join(line_ending) + line_ending

    output = +""
    inserted = false
    content.lines.each do |line|
      key, = raw_xcconfig_setting(line)
      if relevant_keys.include?(key)
        unless inserted
          output << replacement
          inserted = true
        end
      else
        output << line
      end
    end
    output << replacement unless inserted
    output
  end

  def raw_xcconfig_setting(line)
    match = line.match(/\A\s*([A-Za-z0-9_]+(?:\[[^\]]+\])?)\s*=\s*(.*?)(?:\r?\n)?\z/)
    return [] unless match

    [match[1], match[2]]
  end

  def platform_linkage_keys
    [
      "OTHER_LDFLAGS",
      "#{PLATFORM_OTHER_LDFLAGS}[#{DEVICE_SDK}]",
      "#{PLATFORM_OTHER_LDFLAGS}[#{SIMULATOR_SDK}]",
      "EXCLUDED_ARCHS[#{SIMULATOR_SDK}]"
    ]
  end

  def platform_linkage_settings(content)
    settings = content.lines.filter_map do |line|
      key, value = raw_xcconfig_setting(line)
      [key, value] if platform_linkage_keys.include?(key)
    end
    platform_linkage_keys.each do |key|
      occurrences = settings.count { |setting_key, _| setting_key == key }
      if occurrences > 1
        raise Pod::Informative, "Ambiguous generated xcconfig: #{key} is declared more than once."
      end
    end
    settings.to_h
  end

  def device_flags_from_platform_linkage_settings(settings)
    device_flags = settings["#{PLATFORM_OTHER_LDFLAGS}[#{DEVICE_SDK}]"] || settings["OTHER_LDFLAGS"]
    return device_flags if device_flags

    raise Pod::Informative, "Expected OTHER_LDFLAGS in generated xcconfig; refusing simulator cleanup."
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

  def build_provider_plan(aggregate_target, pods_project)
    aggregate_native_target = validate_aggregate_product!(aggregate_target, pods_project)
    amap_labels = amap_pod_target_labels(aggregate_target)
    if amap_labels.empty?
      raise Pod::Informative,
            "Expected AMap pod targets on #{aggregate_target.label}; cannot establish simulator-safe cleanup."
    end

    provider_native_targets = amap_labels.to_h do |label|
      native_target = pods_project.targets.find { |target| target.name == label }
      unless native_target
        raise Pod::Informative,
              "Expected AMap provider target #{label} in the Pods project; cannot establish simulator-safe cleanup."
      end
      [label, native_target]
    end
    provider_pod_targets = amap_pod_targets(aggregate_target)
    provider_pod_targets.each do |pod_target|
      validate_noop_provider_target!(pod_target, provider_native_targets.fetch(pod_target.label), amap_labels)
    end

    direct_dependencies = aggregate_native_target.dependencies.select do |dependency|
      amap_labels.include?(dependency.display_name)
    end
    missing_dependencies = amap_labels - direct_dependencies.map(&:display_name)
    unless missing_dependencies.empty?
      raise Pod::Informative,
            "Expected direct AMap target dependencies #{missing_dependencies.join(", ")} on #{aggregate_target.label}; " \
            "found #{aggregate_native_target.dependencies.map(&:display_name).join(", ").inspect}; " \
            "cannot establish simulator-safe cleanup."
    end
    direct_dependencies.each do |dependency|
      unless dependency.target && dependency.target.name == dependency.display_name
        raise Pod::Informative,
              "Expected resolved AMap dependency #{dependency.display_name} on #{aggregate_target.label}; " \
              "cannot establish simulator-safe cleanup."
      end
    end

    ProviderPlan.new(pods_project: pods_project, dependencies: direct_dependencies)
  end

  def amap_pod_target_labels(aggregate_target)
    amap_pod_targets(aggregate_target).map(&:label)
  end

  def amap_pod_targets(aggregate_target)
    aggregate_target.pod_targets.flat_map do |pod_target|
      [pod_target, *pod_target.recursive_dependent_targets]
    end.select { |pod_target| AMAP_POD_NAMES.include?(pod_target.pod_name) }.uniq(&:label)
  end

  def validate_noop_provider_target!(pod_target, native_target, amap_labels)
    aggregate_class = Xcodeproj::Project::Object::PBXAggregateTarget
    unless native_target.instance_of?(aggregate_class)
      raise Pod::Informative,
            "AMap provider #{pod_target.label} is #{native_target.class}, not a known no-op PBXAggregateTarget."
    end
    if native_target.respond_to?(:product_reference) && native_target.product_reference
      raise Pod::Informative,
            "AMap provider #{pod_target.label} has a product reference; refusing to remove executable linkage."
    end

    phase_methods = %i[build_phases copy_files_build_phases shell_script_build_phases]
    phase_methods.each do |method|
      next unless native_target.respond_to?(method)
      next if native_target.public_send(method).empty?

      raise Pod::Informative,
            "AMap provider #{pod_target.label} has #{method}; it is not a no-op target."
    end

    expected_dependencies = pod_target.dependent_targets
                                      .select { |target| AMAP_POD_NAMES.include?(target.pod_name) }
                                      .map(&:label)
                                      .sort
    actual_dependencies = native_target.dependencies.map do |dependency|
      target = dependency.target
      unless target && amap_labels.include?(target.name)
        raise Pod::Informative,
              "AMap provider #{pod_target.label} has an unknown or non-AMap dependency #{dependency.display_name.inspect}."
      end
      target.name
    end.sort
    unless actual_dependencies == expected_dependencies
      raise Pod::Informative,
            "AMap provider #{pod_target.label} dependency topology changed: expected #{expected_dependencies.inspect}, " \
            "found #{actual_dependencies.inspect}."
    end
  end

  def build_xcconfig_plans(aggregate_target, requires_amap:)
    aggregate_target.xcconfigs.map do |configuration_name, _|
      path = aggregate_target.client_root + aggregate_target.xcconfig_relative_path(configuration_name)
      content = File.binread(path)
      device_flags = device_flags_from_platform_linkage_settings(platform_linkage_settings(content))
      validate_direct_amap_frameworks!(device_flags, aggregate_target.label) if requires_amap
      XcconfigPlan.new(path: path, content: transform_xcconfig_for_platform_linkage(content))
    end
  end

  def validate_direct_amap_frameworks!(device_flags, aggregate_label)
    tokens = lex_raw_linker_flags(device_flags)
    framework_names = []
    tokens.each_with_index do |token, index|
      next unless token.value == "-framework"

      framework_name = tokens[index + 1]&.value
      unless framework_name && !framework_name.empty?
        raise Pod::Informative, "Malformed OTHER_LDFLAGS: -framework has no framework name."
      end
      framework_names << framework_name
    end
    missing_frameworks = AMAP_FRAMEWORKS - framework_names
    return if missing_frameworks.empty?

    raise Pod::Informative,
          "Expected direct iPhoneOS AMap framework linker settings #{missing_frameworks.join(", ")} " \
          "for #{aggregate_label}; refusing simulator cleanup."
  end
end
