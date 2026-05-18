/**
 * PerplexityAgentProvider — calls Perplexity's Agent API (`POST /v1/agent`,
 * OpenAI-compatible aliased as `/v1/responses`) and normalizes the result
 * into our `Dossier` shape.
 *
 * Why this provider:
 *   - Bundles search infrastructure (web_search + fetch_url tools) with
 *     the LLM in a single call. Without this we'd own search-quality
 *     work (Tavily/Brave wiring, citation extraction, etc.).
 *   - Presets are first-class — switching from `deep-research` (gpt-5.2,
 *     cheaper) to `advanced-deep-research` (claude-opus-4-6, presumably
 *     better for humans research) is a config-string change, not a code
 *     change.
 *
 * Synchronous-but-slow: `responses.create` returns when the agent
 * finishes — that can be minutes, with a long tail (30+ min observed).
 * The worker bounds each call with a hard AbortController timeout
 * (RESEARCH_CALL_TIMEOUT_S). On timeout the call is aborted, the job is
 * marked failed, and the drain loop moves on — one hung dossier can't
 * stall the queue.
 */
import { Perplexity } from '@perplexity-ai/perplexity_ai';
import type { ResponseCreateResponse } from '@perplexity-ai/perplexity_ai/resources/responses';
import type {
  Dossier,
  DossierProvider,
  DossierProviderConfig,
  StaffContext,
} from '../types';
import {
  TALENT_DOSSIER_V1_VERSION,
  renderTalentDossierV1Prompt,
} from '../prompt-templates/talent-dossier-v1';

/** Presets we support for v1. Anything else is rejected before the call. */
const SUPPORTED_PRESETS = new Set(['deep-research', 'advanced-deep-research']);

/** Thrown when a call exceeds the per-call timeout. The runner treats
 *  this as retryable (a later attempt might be faster). */
export class ProviderTimeoutError extends Error {
  constructor(ms: number) {
    super(`Perplexity call exceeded ${ms}ms timeout`);
    this.name = 'ProviderTimeoutError';
  }
}

export class PerplexityAgentProvider implements DossierProvider {
  readonly name = 'perplexity_agent';
  private client: Perplexity;
  private timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number) {
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY is required to construct PerplexityAgentProvider');
    }
    this.client = new Perplexity({ apiKey });
    this.timeoutMs = timeoutMs;
  }

  async generate(ctx: StaffContext, config: DossierProviderConfig): Promise<Dossier> {
    if (!SUPPORTED_PRESETS.has(config.preset)) {
      throw new Error(`Unsupported preset for ${this.name}: ${config.preset}`);
    }
    if (config.promptTemplateVersion !== TALENT_DOSSIER_V1_VERSION) {
      // When we add v2, this becomes a switch. For now any mismatch is a bug.
      throw new Error(
        `Only ${TALENT_DOSSIER_V1_VERSION} is implemented; got ${config.promptTemplateVersion}`,
      );
    }

    const prompt = renderTalentDossierV1Prompt(ctx);
    const response = await this.callWithTimeout(prompt, config.preset);

    if (response.status === 'failed') {
      throw new Error(
        `Perplexity returned status=failed: ${response.error?.message ?? '(no error message)'}`,
      );
    }

    const contentMarkdown = response.output_text ?? '';
    if (!contentMarkdown.trim()) {
      throw new Error('Perplexity returned empty output_text');
    }

    return {
      contentMarkdown,
      citations: extractCitations(response),
      searchResults: extractSearchResults(response),
      usageMetadata: {
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalCostUsd: response.usage?.cost?.total_cost ?? 0,
        inputCostUsd: response.usage?.cost?.input_cost,
        outputCostUsd: response.usage?.cost?.output_cost,
        toolCallsCostUsd: response.usage?.cost?.tool_calls_cost,
      },
      confidence: parseConfidence(contentMarkdown),
    };
  }

  /**
   * Hard per-call timeout. AbortController cancels the underlying fetch
   * if the SDK honors the signal; Promise.race guarantees we reject even
   * if it doesn't (the orphaned request settles and is ignored — the
   * process is short-lived so the leak is bounded).
   */
  private async callWithTimeout(
    prompt: string,
    preset: string,
  ): Promise<ResponseCreateResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      const call = this.client.responses.create(
        {
          preset,
          input: prompt,
          tools: [{ type: 'web_search' }, { type: 'fetch_url' }],
          stream: false,
        },
        { signal: controller.signal },
      ) as Promise<ResponseCreateResponse>;
      return await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Citations live as annotations on each output_text content part of message
 * items. Flatten across all message items into a unique-by-URL list.
 */
function extractCitations(
  response: ResponseCreateResponse,
): Array<{ title?: string | undefined; url: string }> {
  const seenUrls = new Set<string>();
  const citations: Array<{ title?: string | undefined; url: string }> = [];
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text' || !part.annotations) continue;
      for (const ann of part.annotations) {
        if (ann.url && !seenUrls.has(ann.url)) {
          seenUrls.add(ann.url);
          citations.push({ title: ann.title, url: ann.url });
        }
      }
    }
  }
  return citations;
}

/**
 * Provider-side search results live in `search_results` output items. The
 * agent may emit multiple of these across the reasoning loop; we flatten.
 */
function extractSearchResults(
  response: ResponseCreateResponse,
): Array<{ title: string; url: string; snippet: string; date?: string | undefined }> {
  const results: Array<{ title: string; url: string; snippet: string; date?: string | undefined }> = [];
  for (const item of response.output) {
    if (item.type !== 'search_results') continue;
    for (const r of item.results) {
      results.push({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        date: r.date,
      });
    }
  }
  return results;
}

/**
 * Parse the dossier's confidence assessment out of the "Identity confidence"
 * section. The template instructs the agent to write the literal word HIGH
 * or LOW in this section; we look for it. Returns null when neither word
 * is found (agent didn't follow the template — the dossier is still
 * usable, but the consumer-side disclaimer can't be auto-rendered).
 *
 * Exported for unit testing.
 */
export function parseConfidence(markdown: string): 'high' | 'low' | null {
  // Match the "## Identity confidence" section up to the next "## " heading.
  const sectionMatch = markdown.match(/##\s+Identity confidence[\s\S]*?(?=\n##\s|$)/i);
  if (!sectionMatch) return null;
  const section = sectionMatch[0];
  // Order matters — check LOW first so a LOW-prefixed section with the
  // word "high" elsewhere (e.g. "high uncertainty") still classifies as low.
  if (/\bLOW\b/.test(section)) return 'low';
  if (/\bHIGH\b/.test(section)) return 'high';
  return null;
}
