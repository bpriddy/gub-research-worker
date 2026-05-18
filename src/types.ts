/**
 * Shared types for the deep-research dossier pipeline.
 *
 * A `DossierProvider` is the seam that lets us swap in a second / third
 * provider later (direct-to-Claude, direct-to-Gemini, etc.) without
 * touching the job runner or the persistence layer. Today the only
 * implementation is `PerplexityAgentProvider`.
 */

/**
 * Input to the provider — everything it needs to render a prompt about a
 * specific staff member. Built by the job runner from the GUB DB at call
 * time so the provider doesn't reach into Prisma.
 */
export interface StaffContext {
  staffId: string;
  fullName: string;
  email: string;
  title: string | null;
  department: string | null;
  /** Names of the teams this staff is currently on. */
  teamNames: string[];
  /** Known external IDs (Google directory ID, Slack, etc.) */
  externalIds: Array<{ system: string; externalId: string }>;
}

/**
 * Provider configuration for a single generation. Both fields are written
 * to the `staff_research_dossiers` row so we can:
 *   - know which preset to UPSERT into when the same job runs again,
 *   - run a new prompt template version without overwriting the old dossier.
 */
export interface DossierProviderConfig {
  /** Provider-specific preset string. v1 perplexity_agent: 'deep-research' | 'advanced-deep-research'. */
  preset: string;
  /** Versioned prompt template ID, e.g. 'talent-dossier-v1'. */
  promptTemplateVersion: string;
}

/**
 * Normalized dossier output. All providers must return this shape. The
 * raw provider payload (provider-specific search results, full response
 * object) is preserved in `searchResults` and `usageMetadata` for the
 * curious-later case; the normalized `citations` + `contentMarkdown` are
 * what the consumer-side renderer uses.
 */
export interface Dossier {
  /** The markdown body of the dossier, ready to render. */
  contentMarkdown: string;
  /** Citations extracted from the provider's response. Title is optional because not every provider exposes it. */
  citations: Array<{ title?: string | undefined; url: string }>;
  /** Richer per-result data (snippets, dates) — useful for debugging the prompt or building filters later. */
  searchResults: Array<{ title: string; url: string; snippet: string; date?: string | undefined }>;
  usageMetadata: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    inputCostUsd?: number | undefined;
    outputCostUsd?: number | undefined;
    toolCallsCostUsd?: number | undefined;
  };
  /**
   * Parsed from the "Identity confidence" section of the markdown. NULL
   * when the worker couldn't classify (i.e. the dossier didn't follow the
   * template's confidence-block instruction). The consumer renders a
   * prominent disclaimer when confidence='low'.
   */
  confidence: 'high' | 'low' | null;
}

export interface DossierProvider {
  /** Stable identifier — matches the `provider` column in research_jobs / staff_research_dossiers. */
  readonly name: string;
  /** Run the provider once for one staff member. Synchronous from the caller's perspective; internally takes minutes. */
  generate(ctx: StaffContext, config: DossierProviderConfig): Promise<Dossier>;
}
