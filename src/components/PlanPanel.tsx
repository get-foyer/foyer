import React from 'react';

interface Props {
  plan: string | null;
}

export function PlanPanel({ plan }: Props) {
  return (
    <section className="panel plan-panel">
      <h2 className="panel__title">Approved Plan</h2>

      {plan === null ? (
        <p className="panel__empty">
          Plan will appear when ExitPlanMode fires.
          <br />
          <span className="panel__hint">Run a task through plan mode to populate this.</span>
        </p>
      ) : (
        <div className="plan-panel__content">
          <pre className="plan-panel__text">{plan}</pre>
        </div>
      )}
    </section>
  );
}
