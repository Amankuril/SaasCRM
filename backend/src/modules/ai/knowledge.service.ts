import type { Types } from 'mongoose';
import { htmlToText, safeFetchText } from '../../lib/safeFetch.js';
import { KnowledgeChunk, KnowledgeSource, type KnowledgeSourceDoc } from './knowledge.model.js';

const CHUNK_CHARS = 900;
const OVERLAP_CHARS = 150;
const MAX_SOURCE_CHARS = 200_000;

/** Splits on paragraph boundaries into ~900-char chunks with a little overlap for context. */
export function chunkText(text: string): string[] {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > CHUNK_CHARS) {
      chunks.push(current);
      current = current.slice(-OVERLAP_CHARS);
    }
    // Very long paragraphs are cut hard.
    for (let i = 0; i < p.length; i += CHUNK_CHARS) {
      const piece = p.slice(i, i + CHUNK_CHARS);
      current = current ? `${current}\n\n${piece}` : piece;
      if (current.length >= CHUNK_CHARS) {
        chunks.push(current);
        current = current.slice(-OVERLAP_CHARS);
      }
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 20 || chunks.length === 1);
}

/** Rebuilds a source's chunks from its content (idempotent). */
export async function indexSource(source: KnowledgeSourceDoc): Promise<void> {
  const workspaceId = source.workspaceId;
  const chunks = chunkText(source.content.slice(0, MAX_SOURCE_CHARS));
  await KnowledgeChunk.deleteMany({ workspaceId, sourceId: source._id });
  if (chunks.length) {
    await KnowledgeChunk.insertMany(chunks.map((text, position) => ({ workspaceId, sourceId: source._id, position, text })));
  }
  source.set({ chunkCount: chunks.length, status: 'ready', error: null, lastIngestedAt: new Date() });
  await source.save();
}

/** Downloads (safely) and re-indexes a URL source. Failures are stored on the source. */
export async function ingestUrl(source: KnowledgeSourceDoc): Promise<void> {
  try {
    const page = await safeFetchText(source.url!);
    const { title, text } = page.contentType.includes('html') ? htmlToText(page.body) : { title: null, text: page.body };
    if (text.length < 50) throw new Error('No readable text found on that page.');
    source.content = text;
    if (title && (!source.title || source.title === source.url)) source.title = title.slice(0, 200);
    source.version += 1;
    await indexSource(source);
  } catch (err) {
    source.set({ status: 'failed', error: (err as Error).message, lastIngestedAt: new Date() });
    await source.save();
  }
}

export interface KnowledgeHit {
  id: string;
  sourceId: string;
  sourceTitle: string;
  text: string;
}

/** Top matching chunks for a question, scoped to one workspace. */
export async function searchKnowledge(workspaceId: Types.ObjectId, query: string, limit = 5): Promise<KnowledgeHit[]> {
  const q = query.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
  if (!q) return [];
  const rows = await KnowledgeChunk.find({ workspaceId, $text: { $search: q } }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .lean();
  const sources = await KnowledgeSource.find({ workspaceId, _id: { $in: rows.map((r) => r.sourceId) } }).select('title').lean();
  const titleOf = new Map(sources.map((s) => [s._id.toString(), s.title]));
  return rows.map((r) => ({ id: r._id.toString(), sourceId: r.sourceId.toString(), sourceTitle: titleOf.get(r.sourceId.toString()) ?? 'Knowledge', text: r.text }));
}
