/**
 * Pure helpers for the structured research reading surface (ResearchTab).
 *
 * Section anchors are derived from `section.heading` in ONE place here, so the in-doc section
 * index and the rendered `<section id>` always agree — no slug drift (this is why we don't need
 * rehype-slug + github-slugger).
 */
import type { ResearchResult, ResearchSection } from '../types';

/** Slugify a heading into an anchor-id fragment. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

/**
 * Unique anchor ids for a section list, deduping collisions (overview, overview-1, overview-2).
 * Returns the display heading alongside the slug so the index and the section render from one source.
 */
export function sectionAnchors(sections: ResearchSection[]): { heading: string; slug: string }[] {
  const seen = new Map<string, number>();
  return sections.map((s, i) => {
    const base = slugify(s.heading || `section-${i + 1}`);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return {
      heading: s.heading || `Section ${i + 1}`,
      slug: n === 0 ? base : `${base}-${n}`,
    };
  });
}

const WORDS_PER_MIN = 200;

/**
 * Estimate read minutes from section prose. Fenced code is stripped so syntax doesn't inflate
 * the count, and `diagram` source is excluded entirely (it lives in its own field, not `body`).
 * Floors at 1 ("~1 min read").
 */
export function estimateReadMinutes(sections: ResearchSection[], lede = ''): number {
  const prose = [lede, ...sections.map((s) => s.body.replace(/```[\s\S]*?```/g, ' '))].join(' ');
  const words = prose.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MIN));
}

/** Serialize a briefing back to markdown for copy-to-clipboard. */
export function serializeToMarkdown(result: ResearchResult): string {
  const parts: string[] = [`# ${result.topic}`];
  if (result.lede) parts.push(result.lede);
  for (const s of result.sections) {
    if (s.heading) parts.push(`## ${s.heading}`);
    parts.push(s.body);
    if (s.diagram) parts.push('```mermaid\n' + s.diagram + '\n```');
  }
  if (result.links.length) {
    parts.push('## Sources');
    parts.push(result.links.map((l, i) => `${i + 1}. [${l.title}](${l.url})`).join('\n'));
  }
  return parts.join('\n\n');
}
