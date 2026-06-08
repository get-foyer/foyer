import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';

// Documents WHY MermaidView must use `flowchart: { htmlLabels: false }`.
//
// MermaidView sanitizes mermaid's SVG with `USE_PROFILES: { svg: true, svgFilters: true }`
// before injecting it (XSS control). That SVG-only profile strips the XHTML that lives
// inside <foreignObject> — which is exactly where mermaid puts node labels when
// htmlLabels is true. Result: labels vanish but the node rects keep their computed
// size → giant empty boxes. With htmlLabels:false, mermaid emits SVG <text>, which
// the same profile preserves. These tests lock that behavior in.
const SANITIZE_OPTS = { USE_PROFILES: { svg: true, svgFilters: true } } as const;

describe('mermaid label sanitization', () => {
  it('STRIPS htmlLabels (foreignObject) text — this is the empty-box bug', () => {
    // What mermaid emits with htmlLabels: true
    const htmlLabelSvg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <g class="node">
          <rect width="200" height="40"></rect>
          <foreignObject width="200" height="40">
            <div xmlns="http://www.w3.org/1999/xhtml">
              <span class="nodeLabel">Run test suite</span>
            </div>
          </foreignObject>
        </g>
      </svg>`;

    const clean = DOMPurify.sanitize(htmlLabelSvg, SANITIZE_OPTS);

    // The label text is gone — confirming the bug.
    expect(clean).not.toContain('Run test suite');
  });

  it('PRESERVES non-html (SVG <text>) labels — this is the htmlLabels:false fix', () => {
    // What mermaid emits with htmlLabels: false
    const textLabelSvg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <g class="node">
          <rect width="200" height="40"></rect>
          <text class="nodeLabel" x="100" y="20">
            <tspan>Run test suite</tspan>
          </text>
        </g>
      </svg>`;

    const clean = DOMPurify.sanitize(textLabelSvg, SANITIZE_OPTS);

    // The label survives — confirming the fix renders visible, correctly-sized nodes.
    expect(clean).toContain('Run test suite');
    expect(clean).toContain('<text');
  });

  it('PRESERVES a graph LR storyline: phase labels and the active-node highlight survive', () => {
    // Representative of what mermaid emits for our `graph LR` milestone storyline
    // with :::goal and :::active classDefs (htmlLabels:false → SVG <text>, classDef
    // colors → fill/stroke presentation attributes). Locks in that the subject
    // node, each phase label, and the active highlight all survive sanitization.
    const storylineSvg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <g class="node goal">
          <rect width="120" height="40" fill="#161b22" stroke="#4493f8"></rect>
          <text class="nodeLabel" x="60" y="20"><tspan>Fix login bug</tspan></text>
        </g>
        <g class="node active">
          <rect width="120" height="40" fill="#1f6feb" stroke="#4493f8"></rect>
          <text class="nodeLabel" x="240" y="20"><tspan>Run tests</tspan></text>
        </g>
      </svg>`;

    const clean = DOMPurify.sanitize(storylineSvg, SANITIZE_OPTS);

    expect(clean).toContain('Fix login bug'); // subject (:::goal) node label
    expect(clean).toContain('Run tests'); // active phase label
    expect(clean).toContain('<text');
    expect(clean).toContain('#1f6feb'); // active-node fill → the highlight is visible
  });

  // Finding: loosening the profile does NOT rescue foreignObject labels.
  // Even adding `html: true`, DOMPurify strips the whole <foreignObject> element
  // (it is not in any USE_PROFILES tag set), so the label is still lost. This is
  // why the fix must be htmlLabels:false (SVG <text>), not a sanitizer tweak.
  it('does NOT rescue foreignObject labels even with the html profile added', () => {
    const htmlLabelSvg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <g class="node">
          <rect width="200" height="40"></rect>
          <foreignObject width="200" height="40">
            <div xmlns="http://www.w3.org/1999/xhtml">
              <span class="nodeLabel">Run test suite</span>
            </div>
          </foreignObject>
        </g>
      </svg>`;

    const clean = DOMPurify.sanitize(htmlLabelSvg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
    });

    // Still stripped — confirms the sanitizer can't be the fix.
    expect(clean).not.toContain('Run test suite');
    expect(clean).not.toContain('foreignObject');
  });
});
