import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

interface Props {
  graph: string | null;
  graphStatus: 'idle' | 'generating' | 'ready' | 'error';
  graphError: string | null;
}

let mermaidInitialized = false;

function ensureMermaid() {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        background: '#13141d',
        primaryColor: '#2a2b3e',
        primaryTextColor: '#cccde0',
        lineColor: '#6b8fff',
        edgeLabelBackground: '#1c1d29',
        secondaryColor: '#1c1d29',
        tertiaryColor: '#252637',
      },
      flowchart: { htmlLabels: true, curve: 'basis' },
    });
    mermaidInitialized = true;
  }
}

export function GraphPanel({ graph, graphStatus, graphError }: Props) {
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
          // Make the SVG responsive
          const svgEl = containerRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.style.maxWidth = '100%';
            svgEl.style.height = 'auto';
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
        Plan Graph
        {graphStatus === 'generating' && (
          <span className="panel__badge panel__badge--generating">Generating…</span>
        )}
      </h2>

      {graphStatus === 'idle' && graph === null && (
        <p className="panel__empty">Graph will appear after the plan is captured.</p>
      )}

      {graphStatus === 'generating' && (
        <div className="graph-panel__generating">
          <span className="spinner" />
          <span>Generating mermaid diagram from plan…</span>
        </div>
      )}

      {(graphStatus === 'error' || renderError) && (
        <div className="graph-panel__error">
          <p className="error-label">⚠ Graph generation failed</p>
          <pre className="error-detail">{graphError ?? renderError}</pre>
          {graph && (
            <>
              <p className="panel__hint">Raw mermaid output:</p>
              <pre className="graph-panel__raw">{graph}</pre>
            </>
          )}
        </div>
      )}

      {graph && !renderError && (
        <div className="graph-panel__svg" ref={containerRef} />
      )}
    </section>
  );
}
