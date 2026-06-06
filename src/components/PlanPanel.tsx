import React from 'react';
import { Markdown } from './Markdown';

interface Props {
  plan: string | null;
}

export function PlanPanel({ plan }: Props) {
  return (
    <section className="panel plan-panel">
      <h2 className="panel__title">Approved Plan</h2>

      {plan === null ? (
        <div className="panel__empty">
          <span className="panel__empty-glyph">◱</span>
          <p>Approved plan will appear here.</p>
          <span className="panel__hint">Captured when the agent&apos;s plan is approved.</span>
        </div>
      ) : (
        <div className="plan-panel__content">
          <Markdown text={plan} className="plan-panel__text" />
        </div>
      )}
    </section>
  );
}
