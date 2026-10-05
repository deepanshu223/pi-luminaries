# Changelog

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
