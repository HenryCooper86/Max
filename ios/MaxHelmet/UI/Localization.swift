import Foundation

// In-code localisation (the project file cannot gain localisation regions).
// Strings live in a table keyed by a dotted id with a zh and an en text, and
// `{name}`-style parameters. Wording follows src/lib/i18n.ts where the same
// string exists on the web. Text that comes from the relay is never passed
// through here.

enum AppLanguage: String, Equatable {
    case zh, en
}

/// What the wearer picked in Settings.
enum AppLanguageChoice: String, CaseIterable, Equatable {
    case system, zh, en
}

enum Loc {
    /// True while XCTest hosts the app: "follow the system" then means Chinese,
    /// so the existing zh assertions keep their meaning whatever the simulator's
    /// language is. A test that wants English sets the choice explicitly.
    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    /// Follow the system language unless overridden: Chinese when the preferred
    /// language is Chinese, English otherwise.
    static func resolve(
        choice: AppLanguageChoice,
        preferred: [String] = Locale.preferredLanguages,
        underTest: Bool = Loc.isRunningTests
    ) -> AppLanguage {
        switch choice {
        case .zh: return .zh
        case .en: return .en
        case .system:
            if underTest { return .zh }
            return (preferred.first ?? "en").lowercased().hasPrefix("zh") ? .zh : .en
        }
    }

    /// Looks up `key` and substitutes `{param}` placeholders. A missing key
    /// returns the key itself (a unit test guards against that).
    static func string(_ key: String, _ language: AppLanguage, _ args: [String: String] = [:]) -> String {
        guard let row = LocalizationTable.rows[key] else { return key }
        var text = language == .zh ? row.zh : row.en
        for (name, value) in args { text = text.replacingOccurrences(of: "{\(name)}", with: value) }
        return text
    }
}

/// The active language's text. Reads the observable theme, so a view that
/// calls it inside `body` re-renders when the language changes.
func L(_ key: String, _ args: (String, String)...) -> String {
    Loc.string(key, VisorTheme.shared.language, Dictionary(args, uniquingKeysWith: { $1 }))
}

func L(_ key: String, in language: AppLanguage, _ args: (String, String)...) -> String {
    Loc.string(key, language, Dictionary(args, uniquingKeysWith: { $1 }))
}

enum LocalizationTable {
    struct Row { let zh: String; let en: String }

    /// Every key, both languages. Built from per-area lists so each stays a
    /// small, quick-to-compile literal.
    static let rows: [String: Row] = {
        var out: [String: Row] = [:]
        for list in [coreRows, settingsRows, navigationRows, statusRows, resilienceRows] {
            for (key, zh, en) in list { out[key] = Row(zh: zh, en: en) }
        }
        return out
    }()
}
