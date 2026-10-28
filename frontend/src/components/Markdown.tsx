import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Minimal Markdown for admin-edited pages (privacy, terms, support):
 * # / ## / ### headings, paragraphs, - and 1. lists, ---, **bold**, *italic*, `code`, [text](url).
 * Builds React elements only (never raw HTML), so the content cannot inject markup.
 */
export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const cls = level === 1 ? 'mt-8 text-2xl font-semibold tracking-tight text-ink' : level === 2 ? 'mt-8 text-lg font-semibold text-ink' : 'mt-6 text-base font-semibold text-ink';
      const Tag = (`h${level + 1}`) as 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={i} className={cls}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(<hr key={i} className="my-8 border-slate-200" />);
      i++;
      continue;
    }
    const bullet = /^[-*]\s+/;
    const numbered = /^\d+[.)]\s+/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      const ordered = numbered.test(trimmed);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(re, ''));
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={i} className={`mt-3 space-y-1.5 pl-5 text-slate-700 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-slate-400`}>
          {items.map((t, j) => (
            <li key={j} className="pl-1 leading-7">{inline(t)}</li>
          ))}
        </List>,
      );
      continue;
    }
    // Paragraph: consecutive non-empty lines that start nothing else.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|[-*]\s|\d+[.)]\s|-{3,}$)/.test(lines[i]!.trim())) {
      para.push(lines[i]!.trim());
      i++;
    }
    blocks.push(<p key={i} className="mt-4 leading-7 text-slate-700">{inline(para.join(' '))}</p>);
  }
  return <div className="[&>*:first-child]:mt-0">{blocks}</div>;
}

const TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="rounded bg-slate-100 px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return <SafeLink key={i} href={link[2]!}>{link[1]}</SafeLink>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const cls = 'font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-800';
  if (href.startsWith('/') && !href.startsWith('//')) return <Link to={href} className={cls}>{children}</Link>;
  if (/^(https?:|mailto:|tel:)/i.test(href)) return <a href={href} className={cls} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener">{children}</a>;
  return <>{children}</>;
}
