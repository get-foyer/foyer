import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

interface Props {
  graph: string | null;
  activityStatus: 'idle' | 'generating' | 'ready' | 'error';
  activityError: string | null;
  /** Lifecycle status of the session — drives the "thinking" state before the first graph arrives. */
  sessionStatus: 'working' | 'waiting' | 'done' | null;
}

let mermaidInitialized = false;

function ensureMermaid() {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      // Prevent mermaid from injecting its own full-page error SVG into the DOM
      // on a parse failure. The .catch() in the render effect already routes to
      // the inline error card — this flag ensures that's the only thing shown.
      suppressErrorRendering: true,
      theme: 'dark',
      // Node labels MUST render as SVG <text>, not HTML inside <foreignObject>.
      // Our DOMPurify pass (USE_PROFILES.svg) strips foreignObject's XHTML, which
      // would delete every label and leave giant empty boxes. mermaid 11.x ignores
      // the flowchart-SCOPED htmlLabels flag for the flowchart renderer — only this
      // TOP-LEVEL flag actually switches labels to <text>/<tspan> (which survive
      // sanitization). Verified against the bundled mermaid via a render probe.
      htmlLabels: false,
      themeVariables: {
        background: '#151b23',
        primaryColor: '#212830',
        primaryTextColor: '#f0f6fc',
        // Default (un-highlighted) phase nodes: set the border explicitly so
        // mermaid stops auto-deriving a muddy tan border from primaryColor. This
        // is what made plain phase nodes look mismatched next to the clean blue
        // :::goal / :::active nodes. Highlighted nodes keep their own classDef
        // colors and are unaffected.
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
}

export function GraphPanel({ graph, activityStatus, activityError, sessionStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    if (!graph || !containerRef.current) return;
    ensureMermaid();
    setRenderError(null);

    const id = `foyer-graph-${++idRef.current}`;

    mermaid
      .render(id, graph)
      .then(({ svg }) => {
        if (containerRef.current) {
          // Sanitize the SVG before injecting to prevent XSS.
          // USE_PROFILES.svg permits SVG elements while stripping script/handlers.
          const clean = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          containerRef.current.innerHTML = clean;
          const svgEl = containerRef.current.querySelector('svg');
          if (svgEl) {
            // The storyline is a horizontal strip (graph LR). Render it at its
            // NATURAL width and let the container (.graph-panel__svg, overflow:auto)
            // scroll horizontally — clamping to maxWidth:100% downscales a wide
            // strip into an unreadable sliver, which was the old behaviour. We
            // read the intrinsic width from the viewBox and pin it so mermaid's
            // own width="100%" attribute can't shrink it back to the panel width.
            const viewBox = svgEl.getAttribute('viewBox');
            const naturalWidth = viewBox ? parseFloat(viewBox.split(/\s+/)[2]) : NaN;
            svgEl.style.maxWidth = 'none';
            svgEl.style.height = 'auto';
            if (Number.isFinite(naturalWidth) && naturalWidth > 0) {
              svgEl.style.width = `${naturalWidth}px`;
            }
          }
        }
      })
      .catch((err: unknown) => {
        setRenderError(err instanceof Error ? err.message : String(err));
      });
  }, [graph]);

  return (
    <section className="panel graph-panel">
      <h2 className="panel__title">
        Workflow
        {activityStatus === 'generating' && (
          <span className="panel__badge panel__badge--generating">Updating…</span>
        )}
      </h2>

      {activityStatus === 'idle' && graph === null && sessionStatus === 'working' && (
        // Agent is working but no graph yet — pulse hint instead of static empty card
        <div className="graph-panel__generating">
          <span className="spinner" />
          <span>Workflow diagram incoming…</span>
        </div>
      )}

      {activityStatus === 'idle' && graph === null && sessionStatus !== 'working' && (
        <div className="panel__empty">
          <span className="panel__empty-glyph">◱</span>
          <p>Graph appears as the agent works.</p>
        </div>
      )}

      {activityStatus === 'generating' && graph === null && (
        <div className="graph-panel__generating">
          <span className="spinner" />
          <span>Building workflow diagram…</span>
        </div>
      )}

      {(activityStatus === 'error' || renderError) && (
        <div className="graph-panel__error">
          <p className="error-label">⚠ Graph generation failed</p>
          <pre className="error-detail">{activityError ?? renderError}</pre>
          {graph && (
            <>
              <p className="panel__hint">Raw mermaid output:</p>
              <pre className="graph-panel__raw">{graph}</pre>
            </>
          )}
        </div>
      )}

      {graph && !renderError && <div className="graph-panel__svg" ref={containerRef} />}
    </section>
  );
}
