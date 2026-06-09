import React, { useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

/**
 * Mermaid rendering for research briefing diagrams (UNTRUSTED, LLM-authored): the diagram is
 * guarded (size + type allowlist, init-directive stripped) and re-themed amber before render.
 *
 * The low-level render+sanitize core is split out as MermaidView so the guard logic stays in
 * MermaidFigure's wrapper. The DOMPurify opts + htmlLabels:false are security-critical and
 * locked by graphSanitize.test.ts.
 */

let mermaidInitialized = false;

function ensureMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    // Prevent mermaid from injecting its own full-page error SVG on a parse failure;
    // the .catch() routes to the inline error card instead.
    suppressErrorRendering: true,
    theme: 'dark',
    // Node labels MUST render as SVG <text>, not HTML inside <foreignObject> — the DOMPurify
    // svg profile strips foreignObject, which would delete every label. See graphSanitize.test.ts.
    htmlLabels: false,
    themeVariables: {
      background: '#151b23',
      primaryColor: '#212830',
      primaryTextColor: '#f0f6fc',
      primaryBorderColor: '#656c76',
      nodeBorder: '#656c76',
      lineColor: '#4493f8',
      edgeLabelBackground: '#212830',
      secondaryColor: '#212830',
      tertiaryColor: '#3d444d',
    },
    flowchart: { htmlLabels: false, curve: 'basis' },
  });
  mermaidInitialized = true;
}

// Module-level monotonic id so concurrent renders (workflow + research) never collide.
let idSeq = 0;

/**
 * The shared async renderer: mermaid.render → DOMPurify(svg) → race-guarded inject → natural
 * width pin → inline error card. `source` can change before a render resolves (a later activity
 * tick); the `cancelled` flag makes a superseded render's .then/.catch a no-op.
 */
export function MermaidView({ source, svgClassName }: { source: string; svgClassName?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!source || !containerRef.current) return;
    ensureMermaid();
    setRenderError(null);

    let cancelled = false;
    const id = `foyer-mermaid-${++idSeq}`;

    mermaid
      .render(id, source)
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) return;
        // USE_PROFILES.svg permits SVG elements while stripping script/handlers (XSS control).
        const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        containerRef.current.innerHTML = clean;
        const svgEl = containerRef.current.querySelector('svg');
        if (svgEl) {
          // Render at natural width; the container scrolls. Clamping to 100% downscales a wide
          // strip into an unreadable sliver.
          const viewBox = svgEl.getAttribute('viewBox');
          const naturalWidth = viewBox ? parseFloat(viewBox.split(/\s+/)[2]) : NaN;
          svgEl.style.maxWidth = 'none';
          svgEl.style.height = 'auto';
          if (Number.isFinite(naturalWidth) && naturalWidth > 0) {
            svgEl.style.width = `${naturalWidth}px`;
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRenderError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (renderError) {
    return (
      <div className="mermaid-view__error">
        <p className="error-label">⚠ Diagram failed to render</p>
        <pre className="error-detail">{renderError}</pre>
      </div>
    );
  }

  return <div className={svgClassName ?? 'mermaid-view__svg'} ref={containerRef} />;
}

// --- Research diagram (untrusted LLM source) ---------------------------------------------

/** Diagram types we render. Anything else (sequence-of-events spam, gantt, huge graphs) is dropped. */
const ALLOWED_TYPES = /^(flowchart\b|graph\b|sequenceDiagram\b|stateDiagram(?:-v2)?\b)/;
/** Parse-time DoS guard: an LLM diagram beyond this is dropped, not rendered. */
const MAX_LEN = 4000;
// Theme research diagrams amber to match the dashboard's signal palette. Uses the live --amber
// (#d29922), matching the current palette — it migrates to the Instrument --signal (#ffb020)
// with the rest of the app, per DESIGN.md.
const AMBER_INIT =
  '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#212830","primaryTextColor":"#f0f6fc","primaryBorderColor":"#d29922","nodeBorder":"#d29922","lineColor":"#d29922","secondaryColor":"#212830","tertiaryColor":"#2d333b","fontFamily":"ui-monospace, SFMono-Regular, monospace"},"flowchart":{"htmlLabels":false}}}%%\n';

/**
 * Mermaid keywords that must never appear as a BARE state id — unquoting `"end"` into
 * `[*] --> end` is a parse error. A quoted label matching one of these is forced through the
 * alias path instead. (`hide empty description` etc. are multi-word, so they never match the
 * single-token bare-id test anyway; the single-token keywords are the ones that bite.)
 */
const STATE_RESERVED = new Set(['end', 'state', 'note', 'as', 'direction', 'hide', 'class']);
const BARE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Rewrite quoted state names in a stateDiagram into valid mermaid.
 *
 * The model is told to quote node labels (correct for flowchart/sequence), but `stateDiagram-v2`
 * rejects quoted state names: `[*] --> "Loading"` is a syntax error — quotes are only legal in the
 * alias form `state "Loading" as Loading`. This normalizes both shapes:
 *
 *   "Loading"        (bare-id-safe, non-reserved)  → unquote inline:  Loading
 *   "Awaiting input" (spaced / reserved / metachar)→ alias form:      state "Awaiting input" as Awaiting_input
 *
 * Only touches sources that start with `stateDiagram`; every other diagram type is returned
 * unchanged (their quoted labels are valid). Replacement is literal (split/join), so labels
 * containing regex metacharacters like `"Retry (3x)"` are handled safely.
 */
function normalizeStateDiagram(src: string): string {
  if (!/^stateDiagram\b/.test(src)) return src;

  const labels = new Set<string>();
  for (const m of src.matchAll(/"([^"]+)"/g)) labels.add(m[1]);
  if (labels.size === 0) return src;

  const usedIds = new Set<string>();
  const aliasLines: string[] = [];
  let body = src;

  for (const label of labels) {
    if (BARE_ID.test(label) && !STATE_RESERVED.has(label)) {
      // Inline unquote — clean output, no alias declaration needed.
      usedIds.add(label);
      body = body.split(`"${label}"`).join(label);
      continue;
    }
    // Alias path: slugify to a safe id, de-collide, declare `state "<label>" as <id>`.
    let base = label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base || /^[0-9]/.test(base) || STATE_RESERVED.has(base)) base = `S_${base || 'state'}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    aliasLines.push(`state "${label}" as ${id}`);
    body = body.split(`"${label}"`).join(id);
  }

  if (aliasLines.length === 0) return body;
  // Insert alias declarations right after the `stateDiagram[-v2]` header line.
  const nl = body.indexOf('\n');
  if (nl === -1) return `${body}\n${aliasLines.join('\n')}`;
  return `${body.slice(0, nl + 1)}${aliasLines.join('\n')}\n${body.slice(nl + 1)}`;
}

/**
 * Guard an LLM-authored diagram: strip any model init directive, normalize stateDiagram quoting,
 * enforce size + type allowlist. Exported for unit testing (graphSanitize.test.ts pattern: test
 * the transform, not mermaid.render).
 */
export function guardDiagram(src: string): string | null {
  const s = normalizeStateDiagram(src.replace(/%%\{[\s\S]*?\}%%/g, '').trim());
  if (!s || s.length > MAX_LEN || !ALLOWED_TYPES.test(s)) return null;
  return s;
}

/**
 * Renders one research section's diagram as a framed figure. Returns null (renders nothing) when
 * the diagram fails the guards — an absent figure is correct, never an error card for bad LLM input.
 */
export function MermaidFigure({ diagram }: { diagram: string }) {
  const source = useMemo(() => {
    const cleaned = guardDiagram(diagram);
    return cleaned ? AMBER_INIT + cleaned : null;
  }, [diagram]);

  if (!source) return null;

  return (
    <figure className="research-figure">
      <MermaidView source={source} svgClassName="research-figure__svg" />
    </figure>
  );
}
