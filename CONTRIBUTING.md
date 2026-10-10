# Contributing to Pi Luminaries

Contributions are welcome: a reproducible bug report, a clearer interaction, or a focused change to the collaboration system.

For bugs, include your Pi version, operating system, steps to reproduce, and what you expected to happen. Include a short relevant transcript or screenshot when it helps; remove credentials and private project content before sharing it.

## Work on the package

Clone the repository and install its development dependencies:

```bash
git clone https://github.com/deepanshu223/pi-luminaries.git
cd pi-luminaries
npm ci
npm run build
```

To try your build in Pi:

```bash
pi -e .
```

The source lives in `src/`, integration tests in `test/`, and the collaboration skill in `skills/`. The tracked `dist/` build lets Pi install directly from GitHub; regenerate it when changing the source or build configuration.

Keep changes focused on the behavior a user will see. For a substantial design change, open an issue with the problem and proposed behavior before implementation.

Prettier owns formatting, TypeScript checks static correctness, tests exercise behavior, and review evaluates design.

## Tests

Run the automated tests with:

```bash
npm test
```

The suite uses Node's built-in test runner. `test/native/` runs real Pi processes with [Pi's faux provider](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#faux-provider-for-tests). The tests script the model's replies; Pi owns streaming, queues, tool execution, sessions, and extension loading. Focused integration tests cover interrupted writes, uncertain delivery, permissions, and transport failures. UI tests use Pi's real editors, selectors, and message components with a small terminal stub. It needs no model credentials or paid model calls. Tests stay in the source repository and are excluded from the npm package.

The real-Pi scenarios cover:

| Journey         | What must keep working                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Native input    | Abort, queue clearing, extension input and error reporting                                                                      |
| Active expert   | Steering reaches the current turn; follow-up waits; interruption preserves queued work                                          |
| Collaboration   | Nested context, custom-context isolation, cross-branch request/reply, and Root waiting for activity                             |
| Extensions      | Approval, adding and removing tools, queued work, and recovery after an extension disappears                                    |
| Retained expert | Two attached clients, model and thinking changes, settings, restart, park/wake, archive/resume, standalone handoff and adoption |

`pack:check` repeats the retained-expert journey using the installed npm tarball. This checks that the shipped package can run an expert, beyond loading the extension.

Run just the real-Pi scenarios with `npm run test:native`. To check another Pi version, set `LUMINARIES_TEST_PI` to its installed `dist/cli.js`. CI runs the full suite on Windows and Linux with the development version, plus the minimum supported Pi on Linux and the newer compatibility host on Windows. The host versions are pinned in `.github/workflows/check.yml`.

For a focused change, run the relevant file:

```bash
node --test --test-timeout=150000 test/integration/command-center.test.mjs
```

## Required checks

At a named acceptance boundary that explicitly requires the complete repository gate:

```bash
npm run format
npm run check
```

`npm run check` runs strict TypeScript, a non-mutating format check, the deterministic test suite, and installed-package verification.

Do not run the full gate during ordinary or minor edits, every commit, or review. After a coherent implementation change, run the smallest relevant focused checks if feedback is needed; run the complete gate once at its named acceptance boundary. For documentation-only changes, use targeted formatting, check links and examples, and run `git diff --check`.

### Test runtime and scope

Every test invocation has a hard three-minute wall-clock ceiling. Use a shorter limit for focused tests, split work that cannot finish within the ceiling, and treat a timeout as a defect to diagnose rather than a reason to extend or blindly rerun the command. Register cleanup as soon as a child process, server, socket, watcher, timer, or Store is acquired so an assertion failure cannot keep Node alive.

Test count is not a quality target, and a code change does not automatically require a test. Add or retain a test only when it can detect a plausible incorrect production flow, dangerous race/crash/recovery boundary, authority violation, or observed regression. Exercise public or production boundaries and assert durable or user-visible outcomes. Do not test an isolated helper merely because it exists, snapshot incidental object shapes, repeat equivalent cases, or preserve deleted internals through tests. Consolidate repetitive boundary cases into tables and remove redundant tests that prove the same transition. Large integration scenarios must remain diagnosable and must clean up on every failure path.

## Prettier standard

Prettier is authoritative for the source, tests, configuration, root Markdown, consumer guides, capability reference, and bundled collaboration skill named by the format scripts. Other documentation is formatted only when edited. Do not hand-align covered code or preserve a personal wrapping style that Prettier will replace.

The explicit project rules are:

- two spaces, never tabs;
- semicolons;
- single quotes where JavaScript or TypeScript permits them;
- object keys quoted only when syntax requires it;
- trailing commas wherever modern JavaScript permits them, producing smaller future diffs;
- spaces inside object braces;
- parentheses around every arrow-function parameter;
- intentional multiline object layout is preserved;
- 120 columns as a wrapping target, not a hard correctness limit;
- LF line endings on every platform;
- existing prose wrapping is preserved.

The configuration spells out important defaults deliberately so the repository standard is visible and does not depend on contributors knowing Prettier's implicit choices.

Prettier does **not** decide naming, module boundaries, API quality, runtime validation, state-machine correctness, or whether an abstraction is justified.

## TypeScript standard

`strict` enables the compiler's core safety family, including null checking, implicit-`any` rejection, strict function and property checking, unknown catch variables, and strict iterator returns.

Luminaries also enables:

- `noImplicitReturns` and `noFallthroughCasesInSwitch` for complete control flow;
- `noUnusedLocals` and `noUnusedParameters` to keep the implementation honest and small;
- `noImplicitOverride` for explicit inheritance behavior;
- `allowUnreachableCode: false` and `allowUnusedLabels: false` for dead-control-flow mistakes;
- `noUncheckedSideEffectImports` so a misspelled side-effect import cannot silently disappear;
- `verbatimModuleSyntax` so type-only and runtime imports remain truthful;
- `isolatedModules` and `erasableSyntaxOnly` so files remain independently transpilable and use JavaScript-like TypeScript suitable for Pi's source-loaded runtime;
- forced module detection so a future import-free file cannot accidentally enter shared script/global scope;
- consistent filename casing across Windows and Unix.

### Boundary rules

Compiler types do not validate RPC, JSON, filesystem, bridge, or model-provided values. At every runtime trust boundary:

1. receive uncertain data as `unknown`;
2. validate its primitive kind, bounds, and allowed values;
3. only then narrow it to a domain type;
4. never make invalid data acceptable through coercion such as `String(value)`; stringification for a diagnostic message is fine, but it is not validation.

Avoid `any`, non-null assertions, broad type assertions, and `@ts-ignore`. If an assertion is genuinely unavoidable, keep it next to the mechanical validation or invariant that proves it.

Every promise must be awaited, returned, or deliberately owned with explicit rejection handling. Resource owners must have bounded, idempotent cleanup.

## Regular-expression policy

Production code is removal-first for regular expressions. Prefer named character predicates, path-segment operations, finite scanners, and explicit parsers that make bounds and failure behavior visible. Dynamic `RegExp` construction and regex-as-parser designs are prohibited. Retain a simple bounded expression only when it is materially clearer than the equivalent code, has no hidden backtracking or Unicode ambiguity, and is justified next to focused adversarial tests.

## Design rules

- Prefer Node and Pi primitives over dependencies.
- Prefer direct modules and functions over factories, one-implementation interfaces, or speculative frameworks.
- Keep one authoritative owner for state and lifecycle transitions.
- Validate at boundaries rather than repeatedly asserting internally.
- Comments explain why an invariant exists, not what the next line says.
- Test meaningful production behavior and failure boundaries; follow the test scope above.
