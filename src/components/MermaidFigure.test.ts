import { describe, it, expect } from 'vitest';
import { guardDiagram } from './MermaidFigure';

// guardDiagram is the render-prep guard for UNTRUSTED, LLM-authored mermaid: it strips any model
// init directive, normalizes stateDiagram quoting, and enforces the size + type allowlist. These
// tests assert on the returned STRING — they do NOT run mermaid.render/parse (async, DOM-heavy,
// flaky in jsdom), matching graphSanitize.test.ts's "test the transform, not mermaid" approach.
//
// The bug these lock in: the research prompt tells the model to quote every node label, which is
// valid for flowchart/sequence but a syntax error in stateDiagram-v2 (`[*] --> "Loading"`). The
// guard rewrites quoted states to valid mermaid so the diagram renders instead of erroring.

describe('guardDiagram — stateDiagram quote normalization', () => {
  it('unquotes simple bare-id state names inline (no alias lines)', () => {
    const out = guardDiagram('stateDiagram-v2\n[*] --> "Loading"\n"Loading" --> "Done"');
    expect(out).toBe('stateDiagram-v2\n[*] --> Loading\nLoading --> Done');
    expect(out).not.toContain('"'); // every quote gone
    expect(out).not.toContain(' as '); // no alias declaration needed for clean ids
  });

  it('converts a multi-word label to the alias form and references the id', () => {
    const out = guardDiagram('stateDiagram-v2\n[*] --> "Awaiting input"\n"Awaiting input" --> [*]');
    expect(out).toContain('state "Awaiting input" as Awaiting_input');
    expect(out).toContain('[*] --> Awaiting_input');
    expect(out).toContain('Awaiting_input --> [*]');
    // The only surviving quotes are inside the single alias declaration.
    expect(out!.match(/"Awaiting input"/g)).toHaveLength(1);
  });

  it('routes a reserved-word label through the alias path, never a bare keyword', () => {
    const out = guardDiagram('stateDiagram-v2\n[*] --> "end"');
    expect(out).toContain('state "end" as S_end');
    expect(out).toContain('[*] --> S_end');
    expect(out).not.toMatch(/-->\s*end\b/); // bare `end` would re-break the parser
  });

  it('replaces labels containing regex metacharacters via literal matching', () => {
    const out = guardDiagram('stateDiagram-v2\n[*] --> "Retry (3x)"\n"Retry (3x)" --> "Done"');
    expect(out).toContain('state "Retry (3x)" as Retry_3x');
    expect(out).toContain('[*] --> Retry_3x');
    expect(out).toContain('Retry_3x --> Done'); // both occurrences replaced
    expect(out!.match(/"Retry \(3x\)"/g)).toHaveLength(1); // only the alias decl
  });

  it('de-collides distinct labels that slugify to the same id', () => {
    const out = guardDiagram('stateDiagram-v2\n"a b" --> "a-b"');
    expect(out).toContain('state "a b" as a_b');
    expect(out).toContain('state "a-b" as a_b_2');
    expect(out).toContain('a_b --> a_b_2');
  });

  it('inserts alias declarations right after the diagram header line', () => {
    const out = guardDiagram('stateDiagram-v2\n[*] --> "Awaiting input"');
    const lines = out!.split('\n');
    expect(lines[0]).toBe('stateDiagram-v2');
    expect(lines[1]).toBe('state "Awaiting input" as Awaiting_input');
  });
});

describe('guardDiagram — passthrough and existing guards', () => {
  it('leaves non-state diagrams (flowchart) and their quoted labels untouched', () => {
    const src = 'flowchart TD\n  A["Run tests"] --> B["Ship"]';
    expect(guardDiagram(src)).toBe(src);
  });

  it('leaves a sequenceDiagram untouched', () => {
    const src = 'sequenceDiagram\n  Alice->>Bob: Hello';
    expect(guardDiagram(src)).toBe(src);
  });

  it('drops a disallowed diagram type', () => {
    expect(guardDiagram('gantt\n  title A Gantt')).toBeNull();
  });

  it('drops an over-length diagram (parse-time DoS guard)', () => {
    const huge = 'stateDiagram-v2\n' + '[*] --> Loading\n'.repeat(400);
    expect(guardDiagram(huge)).toBeNull();
  });

  it('strips a model %%{init}%% directive before the allowlist check', () => {
    const out = guardDiagram('%%{init: {"theme":"dark"}}%%\nstateDiagram-v2\n[*] --> "Loading"');
    expect(out).not.toContain('%%{');
    expect(out).toBe('stateDiagram-v2\n[*] --> Loading');
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(guardDiagram('   ')).toBeNull();
  });
});
