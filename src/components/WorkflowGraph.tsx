import React from 'react';
import { MermaidView } from './MermaidFigure';

interface Props {
  /**
   * A non-null mermaid `graph LR` storyline. The parent (SummaryPanel) only mounts this
   * component when a workflow is warranted AND a graph string exists, so there are no
   * idle / empty / "incoming" states here — visibility is decided upstream.
   */
  graph: string;
}

/**
 * Presentational renderer for the workflow storyline, folded into the Current Focus panel.
 *
 * This is the TRUSTED Mermaid surface (our own prompt produces the `graph LR` with the
 * intentional `:::goal`/`:::active` classDefs). It's a thin wrapper over the shared
 * {@link MermaidView} core — no input guards or re-theming, so it uses the global dark/blue
 * theme and renders the storyline exactly as before. The security-critical sanitize pipeline
 * lives in MermaidView (asserted by graphSanitize.test.ts).
 */
export function WorkflowGraph({ graph }: Props) {
  return <MermaidView source={graph} svgClassName="workflow-graph__svg" />;
}
