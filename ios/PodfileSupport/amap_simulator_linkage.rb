# frozen_string_literal: true

require "cocoapods"
require "xcodeproj"

module AMapSimulatorLinkage
  AMAP_POD_NAMES = ["AMap3DMap-NO-IDFA", "AMapFoundation-NO-IDFA"].freeze
  AMAP_FRAMEWORKS = ["AMapFoundationKit", "MAMapKit"].freeze
  SIMULATOR_SDK = "sdk=iphonesimulator*"
  DEVICE_SDK = "sdk=iphoneos*"
  RawFlagToken = Struct.new(:leading, :raw, :value, :exact_string, keyword_init: true)
  RawFlagStream = Struct.new(:tokens, :trailing, keyword_init: true)
  OtherLdflagsContext = Struct.new(
    :device_flags, :simulator_flags, :fresh_assignment, :transformed,
    keyword_init: true
  )
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
    stream = lex_raw_linker_flags(flags)
    tokens = stream.tokens
    output = +""
    index = 0
    while index < tokens.length
      token = tokens[index]
      if token.value == "-framework"
        framework_name = framework_operand!(tokens[index + 1])
        if AMAP_FRAMEWORKS.include?(framework_name)
          index += 2
          next
        end
      end

      output << token.leading
      output << token.raw
      index += 1
    end
    output << stream.trailing
  end

  def lex_raw_linker_flags(flags)
    tokens = []
    trailing = +""
    index = 0
    while index < flags.length
      leading_start = index
      index += 1 while index < flags.length && flags[index].match?(/\s/)
      leading = flags[leading_start...index]
      if index == flags.length
        trailing = leading
        break
      end

      raw_start = index
      value = +""
      quote = nil
      until index == flags.length || (!quote && flags[index].match?(/\s/))
        character = flags[index]
        if character == "\\"
          raise Pod::Informative, "Malformed OTHER_LDFLAGS: dangling escape." if index + 1 == flags.length
          if flags[index + 1] == "\n" || (flags[index + 1] == "\r" && flags[index + 2] == "\n")
            raise Pod::Informative, "Malformed OTHER_LDFLAGS: line continuations are unsupported."
          end

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
        elsif comment_starts_at?(flags, index)
          raise Pod::Informative, "Malformed OTHER_LDFLAGS: unquoted comment syntax is unsupported."
        else
          value << character
          index += 1
        end
      end
      raise Pod::Informative, "Malformed OTHER_LDFLAGS: unterminated quote." if quote

      raw = flags[raw_start...index]
      tokens << RawFlagToken.new(
        leading: leading,
        raw: raw,
        value: value,
        exact_string: exact_string_token?(raw)
      )
    end
    RawFlagStream.new(tokens: tokens, trailing: trailing)
  end

  def framework_operand!(operand)
    unless operand && operand.exact_string && !operand.value.empty? && !operand.value.start_with?("-") &&
           !operand.value.include?("$") && !contains_comment_syntax?(operand.value)
      raise Pod::Informative, "Malformed OTHER_LDFLAGS: -framework has an ambiguous framework name."
    end

    operand.value
  end

  def exact_string_token?(raw)
    return false if raw.empty?

    if raw.start_with?('"') || raw.start_with?("'")
      raw.end_with?(raw[0]) && raw.length >= 2
    else
      !raw.match?(/(?<!\\)["']/)
    end
  end

  def comment_starts_at?(value, index)
    value[index] == "#" || ["//", "/*", "*/"].include?(value[index, 2])
  end

  def contains_comment_syntax?(value)
    value.include?("#") || value.include?("//") || value.include?("/*") || value.include?("*/")
  end

  # Rewrites only linkage settings inside a generated CocoaPods xcconfig. The
  # device value is copied as raw text and the simulator value is derived by
  # removing exact AMap framework-pair lexemes. All unrelated xcconfig lines
  # and all retained linker lexemes are left byte-for-byte intact.
  def transform_xcconfig_for_platform_linkage(content)
    context = other_ldflags_context(content)
    return content if context.transformed

    assignment = context.fresh_assignment
    device_line = "#{assignment.fetch(:indent)}OTHER_LDFLAGS[#{DEVICE_SDK}] =#{assignment.fetch(:after_equals)}#{assignment.fetch(:ending)}"
    simulator_flags = filter_amap_framework_pairs_raw(context.device_flags)
    simulator_line = "#{assignment.fetch(:indent)}OTHER_LDFLAGS[#{SIMULATOR_SDK}] =#{simulator_flags}#{assignment.fetch(:ending)}"

    content.lines.each_with_index.map do |line, index|
      if index == assignment.fetch(:index)
        "#{device_line}#{simulator_line}"
      else
        clear_exact_amap_simulator_excluded_archs(line)
      end
    end.join
  end

  def clear_exact_amap_simulator_excluded_archs(line)
    body, ending = split_xcconfig_line(line)
    match = body.match(/\A(?<indent>[ \t]*)EXCLUDED_ARCHS\[sdk=iphonesimulator\*\][ \t]*=[ \t]*arm64[ \t]*\z/)
    return line unless match

    "#{match[:indent]}EXCLUDED_ARCHS[#{SIMULATOR_SDK}] =#{ending}"
  end

  def raw_xcconfig_setting(line)
    match = line.match(/\A\s*([A-Za-z0-9_]+(?:\[[^\]]+\])*)\s*=\s*(.*?)(?:\r?\n)?\z/)
    return [] unless match

    [match[1], match[2]]
  end

  def other_ldflags_context(content)
    validate_xcconfig_safety!(content)
    assignments = content.lines.each_with_index.filter_map do |line, index|
      assignment = other_ldflags_assignment(line, index)
      assignment if assignment
    end
    if assignments.empty?
      raise Pod::Informative, "Expected one fresh OTHER_LDFLAGS assignment in generated xcconfig; refusing simulator cleanup."
    end

    fresh = assignments.select { |assignment| assignment.fetch(:qualifiers).empty? }
    qualified = assignments.reject { |assignment| assignment.fetch(:qualifiers).empty? }
    if fresh.length == 1 && qualified.empty? && assignments.length == 1
      return OtherLdflagsContext.new(
        device_flags: fresh.first.fetch(:after_equals),
        fresh_assignment: fresh.first,
        transformed: false
      )
    end

    return transformed_other_ldflags_context(assignments) if fresh.empty?

    raise Pod::Informative,
          "Unsupported OTHER_LDFLAGS assignment shape in generated xcconfig; refusing simulator cleanup."
  end

  def transformed_other_ldflags_context(assignments)
    expected_qualifiers = ["[#{DEVICE_SDK}]", "[#{SIMULATOR_SDK}]"]
    unless assignments.length == 2 && assignments.map { |assignment| assignment.fetch(:qualifiers).first } == expected_qualifiers &&
           assignments.last.fetch(:index) == assignments.first.fetch(:index) + 1
      raise Pod::Informative,
            "Unsupported qualified OTHER_LDFLAGS assignment in generated xcconfig; refusing simulator cleanup."
    end

    device = assignments.first
    simulator = assignments.last
    expected_device_line = "#{device.fetch(:indent)}OTHER_LDFLAGS[#{DEVICE_SDK}] =#{device.fetch(:after_equals)}#{device.fetch(:ending)}"
    expected_simulator_flags = filter_amap_framework_pairs_raw(device.fetch(:after_equals))
    expected_simulator_line = "#{simulator.fetch(:indent)}OTHER_LDFLAGS[#{SIMULATOR_SDK}] =#{expected_simulator_flags}#{simulator.fetch(:ending)}"
    unless device.fetch(:line) == expected_device_line && simulator.fetch(:line) == expected_simulator_line
      raise Pod::Informative,
            "Unsupported transformed OTHER_LDFLAGS assignment in generated xcconfig; refusing simulator cleanup."
    end

    OtherLdflagsContext.new(
      device_flags: device.fetch(:after_equals),
      simulator_flags: simulator.fetch(:after_equals),
      transformed: true
    )
  end

  def other_ldflags_assignment(line, index)
    body, ending = split_xcconfig_line(line)
    if body.match?(/\A[ \t]*OTHER_LDFLAGS(?:\[|[ \t]*=)/)
      match = body.match(/\A(?<indent>[ \t]*)OTHER_LDFLAGS(?<qualifiers>(?:\[[^\]\r\n]+\])*)[ \t]*=(?<after_equals>.*)\z/)
      unless match
        raise Pod::Informative,
              "Unsupported OTHER_LDFLAGS syntax in generated xcconfig; refusing simulator cleanup."
      end
      qualifiers = match[:qualifiers].scan(/\[[^\]\r\n]+\]/)
      return {
        after_equals: match[:after_equals],
        ending: ending,
        indent: match[:indent],
        index: index,
        line: line,
        qualifiers: qualifiers
      }
    end

    nil
  end

  def split_xcconfig_line(line)
    return [line[0...-2], "\r\n"] if line.end_with?("\r\n")
    return [line[0...-1], "\n"] if line.end_with?("\n")

    [line, ""]
  end

  def validate_xcconfig_safety!(content)
    content.lines.each do |line|
      body, = split_xcconfig_line(line)
      if body.match?(/\A[ \t]*AMAP_[A-Za-z0-9_]*(?:\[|[ \t]*=)/)
        raise Pod::Informative,
              "Existing custom AMAP build setting in generated xcconfig; refusing simulator cleanup."
      end
      validate_xcconfig_line_safety!(body)
    end
  end

  def validate_xcconfig_line_safety!(line)
    index = 0
    quote = nil
    while index < line.length
      character = line[index]
      if character == "\\"
        raise Pod::Informative, "Unsupported dangling escape in generated xcconfig; refusing simulator cleanup." if index + 1 == line.length

        index += 2
      elsif quote
        quote = nil if character == quote
        index += 1
      elsif character == '"' || character == "'"
        quote = character
        index += 1
      elsif comment_starts_at?(line, index)
        raise Pod::Informative,
              "Unsupported comment syntax in generated xcconfig; refusing simulator cleanup."
      else
        index += 1
      end
    end
    raise Pod::Informative, "Unsupported unterminated quote in generated xcconfig; refusing simulator cleanup." if quote
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
      device_flags = other_ldflags_context(content).device_flags
      validate_direct_amap_frameworks!(device_flags, aggregate_target.label) if requires_amap
      XcconfigPlan.new(path: path, content: transform_xcconfig_for_platform_linkage(content))
    end
  end

  def validate_direct_amap_frameworks!(device_flags, aggregate_label)
    tokens = lex_raw_linker_flags(device_flags).tokens
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
