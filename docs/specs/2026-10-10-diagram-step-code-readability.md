# Diagram step code readability

Status: specified; implementation pending.

## Problem and goal

Diagram walkthroughs present the diagram alongside a scrolling step panel. Clicking a diagram step already navigates to its associated panel content. Each step can render a long code snippet or source selection in full, making a walkthrough unnecessarily large and forcing reviewers to scroll past unrelated code.

Make code evidence easy to inspect without overwhelming the walkthrough. A reviewer should see the relevant excerpt immediately, inspect additional context deliberately, and trust that source belongs to the reviewed revision.

Example: a step explaining a five-line validation branch in a 100-line function initially shows those five lines with their original line numbers. The reviewer can reveal neighboring lines inline or inspect the complete source selection in a larger viewer without losing their place.

## Scope

Apply the behavior to authored code snippets and source-backed excerpts in diagram step panels on web and desktop. Reuse the presentation for a shared side-peek surface where the same component is used, without changing unrelated document code-block behavior.

Preserve the existing diagram selection, automatic scroll-to-step behavior, Previous/Next controls, panel resizing, and continuous step feed. Do not introduce a selected-step-only layout in this release.

Out of scope: searchable step navigation, new diagram types, failure-path authoring, automatic inference of important lines, changes to the mutually exclusive explanation/source/code authoring model, and repository editing.

## Content and source contract

### Source-backed excerpts

- The authoring agent provides explicit relevant line ranges through the existing source selection/anchor contract. Whiteboard renders the selection; it does not guess which lines matter.
- Source identity includes repository, file, base/head side, and the effective reviewed revision. Resolve per-reference pins or the existing review snapshot according to current precedence. Context and full-source requests must use the same identity.
- Reuse the existing selection resolution and validation. Require resolvable, ordered, in-bounds ranges before displaying source; do not silently clamp invalid ranges or substitute another revision.
- Show original source line numbers. For disjoint ranges, label omitted lines visibly. Keep range boundaries distinct when copying.
- Missing source information or an unresolved range is an unavailable-source state, not permission to infer an excerpt. Any stricter authoring validation must preserve existing valid reviews; enforce new authoring requirements without rewriting stored documents.

### Standalone authored snippets

- Standalone snippets remain supported without repository anchors or revision pins.
- Default preview: first 12 logical lines; shorter snippets display completely. This is a bounded preview, not a claim that the first lines are the most important.
- Display total line count and omitted-line count. Preserve the snippet text and its indentation.
- Number standalone lines from 1 unless an existing authored anchor supplies an original starting line. Show a filename only when available; do not invent a source association.

## Presentation and interactions

### Compact code card

Show a header with filename when available, language when known, displayed range or line count, and an explicit `Copy excerpt` action. Render code with syntax highlighting and original indentation. Unsupported languages and highlighting failures fall back to readable plain text.

Initially show source-selected ranges or the bounded standalone preview. Cap inline code height at 240px so a long explicit range cannot grow the step indefinitely; code can scroll inside that cap. Short excerpts must not acquire unnecessary empty height. Allow horizontal scrolling for long lines.

### Expansion

- Source excerpts expose `Show surrounding context`: reveal five additional lines before and after each selected range, bounded by the file and merging overlapping context windows. Keep relevant lines visibly distinguished. `Hide surrounding context` restores the excerpt.
- Standalone snippets expose `Expand snippet` when truncated, showing the entire snippet within the same inline height cap, with a control to restore the preview.
- Provide `Open full snippet` to inspect the complete authored snippet or complete selected source range(s) in a larger, read-only viewer. For source-backed content, also offer `Open full file` using the same revision; do not confuse the selected snippet with the entire file.
- The larger viewer includes identity information, line numbers, highlighting, copy, and keyboard-accessible close. It must fit the viewport, including narrow layouts.
- Store expansion and inner scroll position per step/code item for the lifetime of the open review session. Revisiting another step must not transfer its expansion state. Invalidate cached state when the content or effective revision changes.
- Opening and closing the larger viewer preserves the active step and panel scroll position. Restore focus to its trigger on close.

### Copy semantics

- `Copy excerpt` copies the currently displayed excerpt/context/preview text, excluding display line numbers, syntax markup, and omission markers. For disjoint source ranges, join the selected chunks in source order with one newline; never include hidden gaps.
- `Copy full snippet` in the larger viewer copies the complete authored snippet or selected source range(s). A full-file view uses `Copy full file`.
- Copy must preserve indentation and never copy a bounded preview under a label promising the full snippet. Show success/failure feedback without changing navigation.

### Loading and unavailable source

Loading and failures remain local to the code card. When the revision, file, or requested range cannot be loaded, show `Source unavailable` with the available file, effective revision, side, and requested range. Keep the step title and any existing explanatory content readable. Disable source-dependent expansion and copy actions. Never silently substitute working-tree content or another commit.

### Accessibility and performance

Expansion controls expose their expanded state and identify the controlled region. Line-number gutters and omission decorations are excluded from copied code and do not pollute screen-reader reading order. The larger viewer has a named dialog, managed focus, Escape-to-close, and viewport-bounded scrolling.

Load additional source on demand, or reuse already loaded source at the exact same pins. Do not create a separate full-file request for every context line. Use the existing highlighting dependency; avoid adding another editor or tokenizer solely for this feature. Pending requests must not display stale results after switching steps or revisions.

## Existing implementation and likely integration points

- `packages/review/app/src/review-components.tsx`: `GuidedTourPanel` renders all stops; `GuidedTourStopMain` and `ReviewPeekContentView` render step content. Source cards currently receive `heightMode="content"`.
- `packages/review/app/src/authored-code-surface.tsx`: authored code renders every line with numbering; the language attribute alone does not provide syntax highlighting.
- `packages/review/app/src/code-block.tsx`: existing highlighting, header, language handling, line count, and copy behavior. Reuse primitives or factor a shared presentation layer without changing unrelated code blocks.
- `packages/review/app/src/CodePeek.tsx`: native and web source rendering; web requests use revision pins and slice resolved ranges. Preserve native capabilities while bringing the agreed presentation to both surfaces.
- `packages/review/app/src/review-panel-model.ts` and `packages/review-protocol/src/contracts.ts`: inspect existing anchors, range resolution, and source pins before proposing any contract change.

Implementation order: confirm source identity and selection contracts; introduce the bounded shared presentation; integrate source context and larger viewer; verify navigation, copy, errors, and accessibility on web and desktop.

## Acceptance criteria

- [ ] A five-line source selection within a 100-line file initially displays only those selected lines, with correct original numbering and source identity.
- [ ] A 100-line standalone snippet initially displays 12 lines and clearly indicates that additional lines are hidden; a five-line snippet displays all five.
- [ ] Syntax highlighting works for supported languages; unknown languages remain readable. Code indentation and configured code font size are preserved.
- [ ] Inline context/expansion stays within the height cap and can be collapsed without changing the active diagram step.
- [ ] Context uses the same revision and side as the excerpt, handles file boundaries and overlapping/disjoint ranges, and distinguishes relevant lines.
- [ ] The larger viewer opens complete content with accurate labels; closing it restores focus, active step, and panel position.
- [ ] Copy excerpt, full snippet, and full file actions return exactly the promised text without gutters or presentation markers.
- [ ] Revisiting a step restores its expansion and code scroll state during the review session; content/revision changes cannot reuse stale content or state.
- [ ] Missing files/revisions and invalid ranges display an explicit unavailable state with source identity. Other step content remains usable.
- [ ] Clicking diagram steps, Previous/Next, scroll-based step synchronization, and panel resizing continue to work with both collapsed and expanded code.
- [ ] Keyboard users can expand, open, copy, and close content; narrow layouts keep controls and viewer content accessible.
- [ ] Equivalent behavior is verified on web and desktop/native code surfaces.

## Verification

Add behavioral coverage to existing review-components, CodePeek, and code-block browser suites, plus focused range/copy tests where useful. Test the acceptance examples through an actual diagram walkthrough rather than relying only on isolated code-card rendering. Include multiple long snippets, rapid step changes during loading, disjoint ranges, an unavailable pinned revision, and keyboard focus restoration. Do not add snapshot/string assertions that merely mirror implementation structure or other change-detector tests.

Run focused browser tests for the changed surfaces, canvas typecheck, and applicable lint/build checks. Validate the native desktop path separately from browser coverage. Report automated checks and observed runtime behavior separately; neither this spec nor issue creation constitutes implementation validation.
