import { AiProviderError, type AiProvider, type AnswerRequest, type AnswerResult } from '../src/modules/ai/provider.js';

type Behaviour = (req: AnswerRequest) => Partial<AnswerResult> | Promise<Partial<AnswerResult>>;

/** Records every model request; tests script the responses. */
export class FakeAi implements AiProvider {
  readonly name = 'fake';
  requests: AnswerRequest[] = [];
  next: Behaviour[] = [];

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.requests.push(req);
    const behaviour = this.next.shift();
    const out = behaviour ? await behaviour(req) : {};
    return { answer: 'Default answer', handoff: false, reason: 'ok', source_ids: [], model: req.model, inputTokens: 120, outputTokens: 30, ...out };
  }
}

export const aiError = (kind: AiProviderError['kind'], message = `fake ${kind}`) => () => {
  throw new AiProviderError(message, kind);
};

/** Snippet ids the request offered, in order. */
export function offeredSnippets(req: AnswerRequest): string[] {
  return [...(req.messages.at(-1)?.content ?? '').matchAll(/<snippet id="([^"]+)">/g)].map((m) => m[1]!);
}
