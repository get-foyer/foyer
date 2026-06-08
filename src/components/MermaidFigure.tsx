import React, { useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

/**
 * Shared Mermaid rendering for the whole app. Two surfaces use it:
 *  - WorkflowGraph (TRUSTED): our own `graph LR` storyline, the global dark/blue theme.
 *  - MermaidFigure (UNTRUSTED): an LLM-authored research diagram, guarded + re-themed amber.
 *
 * Only the low-level render+sanitize core is shared (MermaidView); the trusted vs untrusted
 * concerns stay in their own thin wrappers so research's guards never run on the stable graph.
 * The DOMPurify opts + htmlLabels:false are security-critical and locked by graphSanitize.test.ts.
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
// Re-theme research diagrams amber to distinguish them from the blue workflow graph. Uses the
// live --amber (#d29922), matching the current palette — it migrates to the Instrument --signal
// (#ffb020) with the rest of the app, per DESIGN.md.
const AMBER_INIT =
  '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#212830","primaryTextColor":"#f0f6fc","primaryBorderColor":"#d29922","nodeBorder":"#d29922","lineColor":"#d29922","secondaryColor":"#212830","tertiaryColor":"#2d333b","fontFamily":"ui-monospace, SFMono-Regular, monospace"},"flowchart":{"htmlLabels":false}}}%%\n';

/** Guard an LLM-authored diagram: strip any model init directive, enforce size + type allowlist. */
function guardDiagram(src: string): string | null {
  const s = src.replace(/%%\{[\s\S]*?\}%%/g, '').trim();
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
