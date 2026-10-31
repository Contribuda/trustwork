import type { ReactNode } from 'react';
import { typo } from '@/app/_lib/typo';

export type BodyHeading = { id: string; text: string };

/**
 * Markdown-lite for publication bodies (trusted product fixtures): `## ` headings with anchors for the table of
 * contents, `> ` quotes, `- ` lists and paragraphs. Titles and short copy pass through `typo()`.
 */
export function renderBody(body: string): { nodes: ReactNode[]; headings: BodyHeading[] } {
  const headings: BodyHeading[] = [];
  const nodes = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, i) => {
      if (block.startsWith('## ')) {
        const id = `section-${headings.length + 1}`;
        headings.push({ id, text: block.slice(3) });
        return (
          <h2 key={i} id={id}>
            {typo(block.slice(3))}
          </h2>
        );
      }
      if (block.startsWith('> ')) return <blockquote key={i}>{typo(block.replace(/^> ?/gm, ''))}</blockquote>;
      if (block.split('\n').every((line) => line.startsWith('- '))) {
        return (
          <ul key={i}>
            {block.split('\n').map((line, j) => (
              <li key={j}>{typo(line.slice(2))}</li>
            ))}
          </ul>
        );
      }
      return <p key={i}>{typo(block)}</p>;
    });
  return { nodes, headings };
}
