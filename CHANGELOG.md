# Changelog

## 0.1.3 — 2026-10-11

- Keep messages and follow-ups deliverable when a busy expert finishes, is interrupted, or changes extensions. Recover queued input without delivering it twice.
- Notify the sender when a steer misses its intended turn, and resolve failed requests instead of leaving the requester waiting.
- Report Pi input-handler failures instead of leaving an expert stuck on Working, and clear acknowledged uncertainty warnings when work continues.
- Resume constellations when an extension source is missing. Keep affected experts' messages available and resume delivery when their extension selection is corrected.
- Allow `set_extensions` in `serviceGrant` without preventing Root from starting.
- Recover stale owner locks more reliably on Windows and macOS while preserving the single-writer check.
- Preserve complete expert-card values when editing from the dashboard or an attached terminal.
- Handle nested recent-context launches using Pi's own message conversion, and improve large-image conversation handling and terminal-width rendering.
- Replace redundant tests with focused integration checks and real-Pi journeys covering collaboration, controls, extensions, shared views, recovery, and session handoffs.
- Add troubleshooting guidance, clarify extension configuration and saved-state locations, and improve package and skill discovery.
- Raise the minimum supported Pi version to 0.84.4 for native queued-input recovery.

## 0.1.2 — 2026-10-05

- Support Pi 1.0's fullscreen selection and scrolling while keeping regular terminal mode working.
- Use Pi's collapsible tool rendering in expert conversations, respect thinking-display settings, and show thinking and compaction activity.
- Simplify session adoption to an optional name and make pickers easier to distinguish from the dashboard behind them.
- Leave fresh-session context handling to Pi; transfer parent context only when requested.
- Clear obsolete attention notices when the affected expert is closed.
- Keep documentation and package metadata edits from invalidating the loaded runtime build.
- Attribute dashboard and attachment input to Luminaries while preserving Root and expert identities on their tool messages.
- Respect project trust when reading thinking-display settings on older Pi versions.
- Add foundations and a capability reference; expand usage guidance for shared terminals, session handoffs, controls, nesting, and extension access.

## 0.1.1 — 2026-09-19

- Handle large images and multi-image Pi tool results without artificial transport failures.
- Keep late replies addressable while work continues after a request deadline, and preserve valid state when reopening a constellation.
- Clear recovered “Needs you” states correctly and clean up expired requests after recovery.
- Explain how to resend a follow-up when an expert has finished, and make request deadlines and late-reply notifications clearer.
- Show feedback while the command center first opens, make long session-adoption lists scrollable, and keep the Archived shortcut visible.
