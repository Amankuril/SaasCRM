import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../../config/env.js';

/** What the model must return for every customer question. */
export const answerSchema = z.object({
  // Reply to send to the customer (empty when handing off).
  answer: z.string(),
  // True when the knowledge doesn't cover the question, it needs a human, or it's sensitive.
  handoff: z.boolean(),
  // Short internal reason, shown to the team on handoff.
  reason: z.string(),
  // Ids of the knowledge snippets the answer relied on.
  source_ids: z.array(z.string()),
});
export type AnswerOutput = z.infer<typeof answerSchema>;

const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'Message to send to the customer. Empty string when handoff is true.' },
    handoff: { type: 'boolean', description: 'true if a human teammate should take over.' },
    reason: { type: 'string', description: 'One short sentence for the team explaining the decision.' },
    source_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the knowledge snippets used.' },
  },
  required: ['answer', 'handoff', 'reason', 'source_ids'],
  additionalProperties: false,
} as const;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnswerRequest {
  apiKey: string | null;
  model: string;
  system: string;
  messages: ChatTurn[];
}

export interface AnswerResult extends AnswerOutput {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type AiErrorKind = 'not_configured' | 'auth' | 'rate_limit' | 'unavailable' | 'refused' | 'invalid_output';

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: AiErrorKind,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  readonly name: string;
  answer(req: AnswerRequest): Promise<AnswerResult>;
}

/** Models that support server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export class ClaudeProvider implements AiProvider {
  readonly name = 'anthropic';

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    const apiKey = req.apiKey ?? env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AiProviderError('No Anthropic API key configured.', 'not_configured');
    const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: req.model,
        max_tokens: 16000,
        system: req.system,
        messages: req.messages,
        // Short chat replies: low effort keeps latency and cost down.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMA } },
        // If a safety classifier declines, retry server-side on Anthropic's recommended model.
        ...(FALLBACK_MODELS.has(req.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiProviderError('The Anthropic API key was rejected.', 'auth');
      }
      if (err instanceof Anthropic.RateLimitError) throw new AiProviderError('AI rate limit reached. Try again shortly.', 'rate_limit');
      if (err instanceof Anthropic.BadRequestError) throw new AiProviderError(`AI request rejected: ${err.message}`, 'invalid_output');
      if (err instanceof Anthropic.APIError) throw new AiProviderError('The AI service is unavailable right now.', 'unavailable');
      throw err;
    }

    if (response.stop_reason === 'refusal') throw new AiProviderError('The AI declined to answer this message.', 'refused');
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let parsed: AnswerOutput;
    try {
      parsed = answerSchema.parse(JSON.parse(text));
    } catch {
      throw new AiProviderError('The AI returned an unexpected format.', 'invalid_output');
    }
    return { ...parsed, model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
}

/**
 * Deterministic stand-in for development and demos (no API key, no cost):
 * answers with the best matching knowledge snippet, hands off when nothing matches.
 */
export class SandboxAiProvider implements AiProvider {
  readonly name = 'sandbox';

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    const last = req.messages.at(-1)?.content ?? '';
    const snippets = [...last.matchAll(/<snippet id="([^"]+)">\n?([\s\S]*?)<\/snippet>/g)].map((m) => ({ id: m[1]!, text: m[2]!.trim() }));
    const question = /<customer_message>\n?([\s\S]*?)<\/customer_message>/.exec(last)?.[1]?.trim() ?? '';
    const words = new Set(question.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
    const best = snippets
      .map((s) => ({ ...s, score: (s.text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
      .sort((a, b) => b.score - a.score)[0];

    const usage = { model: `sandbox:${req.model}`, inputTokens: Math.ceil((req.system.length + last.length) / 4), outputTokens: 40 };
    if (!best || best.score === 0) {
      return { answer: '', handoff: true, reason: 'Sandbox: no knowledge snippet matches the question.', source_ids: [], ...usage };
    }
    return { answer: best.text.slice(0, 600), handoff: false, reason: 'Sandbox: answered from the best matching snippet.', source_ids: [best.id], ...usage };
  }
}

let provider: AiProvider | undefined;

export function aiProvider(): AiProvider {
  provider ??= env.AI_PROVIDER === 'sandbox' ? new SandboxAiProvider() : new ClaudeProvider();
  return provider;
}

/** Test hook. */
export function setAiProvider(next: AiProvider | undefined): void {
  provider = next;
}
