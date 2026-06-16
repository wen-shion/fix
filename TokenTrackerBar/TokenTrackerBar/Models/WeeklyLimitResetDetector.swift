import Foundation

extension Notification.Name {
    /// Posted when a usage-limit window rolls over after the user had been
    /// meaningfully constrained — the moment worth celebrating with confetti.
    /// `object` is the first `LimitResetEvent`.
    static let weeklyLimitReset = Notification.Name("WeeklyLimitReset")
}

/// One window that just reset after the user had climbed high in it.
struct LimitResetEvent: Equatable {
    let provider: String      // "claude", "codex", "cursor", …
    let windowKey: String     // e.g. "codex.primary"
    let previousPercent: Double
}

/// Detects when a usage-limit window "resets" (rolls over) *after* the user had
/// been meaningfully constrained. Mirrors the idea behind CodexBar's
/// weekly-limit-reset detector but generalized to any provider window.
///
/// The logic is pure and the memory lives in a persisted `Snapshot`, so it
/// survives relaunches and never double-fires (a cooldown suppresses repeats).
struct WeeklyLimitResetDetector {

    /// A real rollover must drop usage by at least this much — a small floor that
    /// confirms the window actually emptied, and guards providers (e.g. Kiro) whose
    /// `reset_at` slides forward continuously instead of jumping only on rollover.
    /// Not a "used enough to celebrate" gate: any genuine reset fires.
    var minDrop: Double = 5
    /// The window's `reset_at` must advance by at least this much to count as a real
    /// rollover — filters sub-second jitter in provider timestamps. A true rollover
    /// jumps hours-to-days ahead, so this never suppresses a genuine reset.
    var resetAdvanceTolerance: TimeInterval = 60
    /// After firing for a key, suppress re-fires for this long.
    var cooldown: TimeInterval = 3600

    struct Snapshot: Codable, Equatable {
        var lastPercent: [String: Double] = [:]
        var lastEventAt: [String: Double] = [:]   // unix seconds
        var lastResetAt: [String: Double] = [:]   // unix seconds — last seen window reset_at

        init() {}

        /// Tolerate older persisted snapshots that predate `lastResetAt` (or any
        /// missing field) so an upgrade keeps the existing baseline + cooldown
        /// memory instead of discarding it.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            lastPercent = try c.decodeIfPresent([String: Double].self, forKey: .lastPercent) ?? [:]
            lastEventAt = try c.decodeIfPresent([String: Double].self, forKey: .lastEventAt) ?? [:]
            lastResetAt = try c.decodeIfPresent([String: Double].self, forKey: .lastResetAt) ?? [:]
        }
    }

    /// Given the persisted snapshot and the current readings, return the events to
    /// celebrate plus the snapshot to persist for next time. The snapshot *is* the
    /// memory of the previous reading, so callers need not track the prior response.
    func evaluate(
        readings: [(provider: String, windowKey: String, usedPercent: Double, resetAt: Double?)],
        snapshot: Snapshot,
        now: Double
    ) -> (events: [LimitResetEvent], snapshot: Snapshot) {
        var updated = snapshot
        var events: [LimitResetEvent] = []

        for reading in readings {
            let key = reading.windowKey
            let prevPercent = snapshot.lastPercent[key]
            let prevReset = snapshot.lastResetAt[key]
            updated.lastPercent[key] = reading.usedPercent
            if let resetAt = reading.resetAt { updated.lastResetAt[key] = resetAt }   // keep last value when missing

            // Need a full prior baseline (percent + reset time) and a current reset
            // time. First observation, or a window without a reset timestamp, only
            // records a baseline — never celebrates.
            guard let prevPercent, let prevReset, let curReset = reading.resetAt else { continue }
            // The window must have actually rolled over: its reset_at advanced to a
            // new period, not merely a percentage that dipped.
            guard curReset > prevReset + resetAdvanceTolerance else { continue }
            // … and the rollover actually emptied the window (also guards Kiro's
            // continuously-sliding reset_at from firing without a real drop).
            guard prevPercent - reading.usedPercent >= minDrop else { continue }
            if let last = snapshot.lastEventAt[key], now - last < cooldown { continue }

            updated.lastEventAt[key] = now
            events.append(LimitResetEvent(provider: reading.provider, windowKey: key, previousPercent: prevPercent))
        }

        return (events, updated)
    }
}

// MARK: - Persistence + settings keys

extension WeeklyLimitResetDetector {
    static let snapshotKey = "WeeklyLimitResetSnapshot"
    static let confettiEnabledKey = "LimitsConfettiOnResetEnabled"
    /// Single source of truth for the confetti opt-out default (on by default).
    static let confettiEnabledDefault = true

    /// Whether the celebration confetti is enabled, honoring the shared default.
    static func confettiEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: confettiEnabledKey) as? Bool ?? confettiEnabledDefault
    }

    static func loadSnapshot(_ defaults: UserDefaults = .standard) -> Snapshot {
        guard let data = defaults.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            return Snapshot()
        }
        return snapshot
    }

    static func saveSnapshot(_ snapshot: Snapshot, _ defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: snapshotKey)
    }
}

// MARK: - Reading extraction

/// Parse an ISO-8601 reset timestamp into unix seconds, tolerating the
/// fractional-seconds variant. Mirrors the display-side parser in `UsageLimitsView`.
private func parseResetSeconds(iso: String?) -> Double? {
    guard let iso else { return nil }
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fmt.date(from: iso) { return date.timeIntervalSince1970 }
    fmt.formatOptions = [.withInternetDateTime]
    return fmt.date(from: iso)?.timeIntervalSince1970
}

extension UsageLimitsResponse {
    /// Flatten every provider's windows into `(provider, windowKey, usedPercent, resetAt)`
    /// tuples (percent on a 0–100 scale, resetAt in unix seconds), skipping providers
    /// that errored or are unconfigured.
    func limitWindowReadings() -> [(provider: String, windowKey: String, usedPercent: Double, resetAt: Double?)] {
        var out: [(provider: String, windowKey: String, usedPercent: Double, resetAt: Double?)] = []

        func addGeneric(_ provider: String, _ configured: Bool, _ error: String?, _ windows: [(String, GenericLimitWindow?)]) {
            guard configured, error == nil else { return }
            for (name, window) in windows {
                guard let window else { continue }
                out.append((provider, "\(provider).\(name)", window.usedPercent, parseResetSeconds(iso: window.resetAt)))
            }
        }

        if claude.configured, claude.error == nil {
            for (name, window) in [("5h", claude.fiveHour), ("7d", claude.sevenDay), ("opus", claude.sevenDayOpus)] {
                guard let window else { continue }
                out.append(("claude", "claude.\(name)", window.utilization, parseResetSeconds(iso: window.resetsAt)))
            }
        }

        if codex.configured, codex.error == nil {
            let windows: [(String, CodexWindow?)] = [
                ("primary", codex.primaryWindow), ("secondary", codex.secondaryWindow),
                ("sparkPrimary", codex.sparkPrimaryWindow), ("sparkSecondary", codex.sparkSecondaryWindow),
            ]
            for (name, window) in windows {
                guard let window else { continue }
                out.append(("codex", "codex.\(name)", Double(window.usedPercent), window.resetAt.map(Double.init)))
            }
        }

        addGeneric("cursor", cursor.configured, cursor.error, [("primary", cursor.primaryWindow), ("secondary", cursor.secondaryWindow), ("tertiary", cursor.tertiaryWindow)])
        addGeneric("gemini", gemini.configured, gemini.error, [("primary", gemini.primaryWindow), ("secondary", gemini.secondaryWindow), ("tertiary", gemini.tertiaryWindow)])
        addGeneric("kiro", kiro.configured, kiro.error, [("primary", kiro.primaryWindow), ("secondary", kiro.secondaryWindow)])
        addGeneric("antigravity", antigravity.configured, antigravity.error, [("primary", antigravity.primaryWindow), ("secondary", antigravity.secondaryWindow), ("tertiary", antigravity.tertiaryWindow)])
        if let kimi { addGeneric("kimi", kimi.configured, kimi.error, [("primary", kimi.primaryWindow), ("secondary", kimi.secondaryWindow), ("tertiary", kimi.tertiaryWindow)]) }
        if let grok { addGeneric("grok", grok.configured, grok.error, [("primary", grok.primaryWindow), ("secondary", grok.secondaryWindow)]) }
        if let copilot { addGeneric("copilot", copilot.configured, copilot.error, [("primary", copilot.primaryWindow), ("secondary", copilot.secondaryWindow)]) }

        return out
    }
}
