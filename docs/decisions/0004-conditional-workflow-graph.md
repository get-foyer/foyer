# 4. Conditional workflow graph, folded into Current Focus

Date: 2026-06-06
Status: Accepted

## Context

The dashboard always rendered a standalone `02 · WORKFLOW` module (`GraphPanel`). The
backend always produced a graph: every provider fell back to a `FALLBACK_GRAPH` ("Working…"
single node) when the model returned nothing, so `Session.graph` was effectively never null.
The result: a trivial one-step task or a quick question/answer still surfaced a whole workflow
panel showing a thin, useless 1–2 node graph — chrome that earns no pixels, which the
"Instrument" design system (every element is a readout or a signal, never decoration) rejects.

There was no classifier; all derivation (summary, graph, topics) is one LLM call
(`buildActivityPrompt`), the same call ADR 0001 widened for research topics. The model is the
de-facto classifier. The README framing ("a mermaid graph of the plan") also implies the graph
belongs _with_ the focus narrative, not beside it as a peer module.

Two visibility decisions were genuinely independent and had to be modelled separately:
graph **content** is session-spanning (the prompt draws a storyline "across the WHOLE session,"
append-only) and must never be destroyed; graph **visibility** is turn-scoped ("re-decide each
prompt") so a trivial follow-up turn hides a workflow a richer earlier turn had drawn.

## Decision

1. **Fold the graph into `01 · CURRENT FOCUS`** (`SummaryPanel`), rendered above the narration
   only when warranted. The standalone WORKFLOW module is removed; modules renumber to
   `01 Current Focus / 02 Touch Points / 03 Research`. A trivial task renders no workflow chrome.

2. **Hybrid visibility trigger.** Show a workflow when the agent went through plan mode this turn
   (`ExitPlanMode`) **OR** the model judged the work multi-phase. The model now returns a
   **nullable** graph — `null` for single-step / Q&A / trivial linear work — via a shared
   `normalizeGraph()` in `server/providers/text.ts` (this killed the per-provider `FALLBACK_GRAPH`
   triplication, the same drift that caused a prior research-500). The plan-mode signal is fed into
   the prompt so a planned turn always draws a graph.

3. **Sticky per turn, via one turn-stamped field.** `Session.workflowTurnSeq` records the turn a
   workflow was warranted; visibility is `workflowTurnSeq === turnSeq` (`isWorkflowVisible`). It is
   sticky within a turn (a later null tick can't hide it) and stale on the next prompt (the
   `turnSeq` bump re-decides fresh). Content is monotonic: `setActivity` never overwrites a non-null
   `graph` with null.

4. **The plan-mode marker is ephemeral, server-only** (a `Map` in `state.ts`, mirroring
   `inFlightResearch`), NOT a persisted `Session` field — the signal only matters for the live turn,
   and a restart demotes the session to `interrupted` anyway, so there is nothing to restore.
   `workflowTurnSeq` is the only new persisted field.

## Consequences

- No empty/thin workflow module for trivial work; the graph reads as part of the session's living
  "readme" (the focus narrative). The "Instrument" module list drops to three.
- Graph content survives hidden turns: a trivial turn 2 hides the workflow but the storyline
  reappears, extended, on a later multi-phase turn 3.
- Edge: a planned turn whose model still returns null briefly shows a one-line "Sketching workflow…"
  hint until the next tick draws it. Accepted (transient; the prompt forces a graph when planned).
- The `WorkflowGraph` component keeps the exact mermaid + DOMPurify (`USE_PROFILES.svg`,
  `htmlLabels:false`) + natural-width-pin pipeline (security-critical; `graphSanitize.test.ts`) and
  the `:::goal`/`:::active` classDef highlight; only the panel chrome and idle/empty states were
  dropped.
- Watch item (TODOS.md): a hidden trivial turn still feeds `previousGraph` back, so the model
  _could_ append a low-value node; the 6-node cap bounds it. Gate graph-extension on `showWorkflow`
  only if dogfooding shows noise.
- Out of scope: Instrument palette/typography adoption, capturing approved-plan text into the graph,
  responsive graph downscaling, an eval harness for the prompt.

## Key files

`src/types.ts` (`workflowTurnSeq`, `isWorkflowVisible`), `server/state.ts` (`setActivity` sticky
logic, ephemeral `plannedTurn` + `markPlanned`), `server/activity.ts`, `server/hooks.ts`,
`server/providers/{index,text,codex,claudeCli,anthropicApi}.ts`,
`server/providers/schema/activity.schema.json`, `server/store.ts`,
`src/components/{WorkflowGraph,SummaryPanel}.tsx`, `src/App.tsx`, `src/styles.css`.
