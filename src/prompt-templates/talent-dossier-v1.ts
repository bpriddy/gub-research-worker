/**
 * talent-dossier-v1 — first prompt template for the casting dossier.
 *
 * The version constant flows into research_jobs.prompt_template_version
 * and staff_research_dossiers.prompt_template_version. Re-running with a
 * bumped version creates a new dossier row (UNIQUE includes the version),
 * so we can A/B the prompt and keep the old outputs visible for review.
 *
 * Bumping the version: copy this file to talent-dossier-v2.ts with a new
 * exported version constant, register it in the runner, leave v1 in
 * place. Do NOT edit v1 once it has produced dossiers in prod — the
 * historical-output guarantee depends on the prompt+version pair being
 * immutable.
 */

import type { StaffContext } from '../types';

export const TALENT_DOSSIER_V1_VERSION = 'talent-dossier-v1';

export function renderTalentDossierV1Prompt(ctx: StaffContext): string {
  const externalIdsBlock =
    ctx.externalIds.length > 0
      ? ctx.externalIds
          .map((e) => `  ${e.system}: ${e.externalId}`)
          .join('\n')
      : '  (none on file)';
  const teamsLine =
    ctx.teamNames.length > 0 ? ctx.teamNames.join(', ') : '(no team affiliation on file)';

  return `You are conducting deep research to build a detailed profile of a person for a casting and collaboration context. Gather a wide range of signals — professional, public, personal, and social — to help collaborators understand who this person is, what they've made, what they care about, and how they show up publicly.

Subject:
  Name:        ${ctx.fullName}
  Email:       ${ctx.email}
  Role:        ${ctx.title ?? '(unknown)'}
  Department:  ${ctx.department ?? '(unknown)'}
  Teams:       ${teamsLine}
  External IDs:
${externalIdsBlock}

Use the web_search and fetch_url tools liberally. Prefer primary, verified sources (agency pages, verified socials, interviews, press releases, archived authoritative aggregators) over forums and unattributed mentions. Cite every claim.

Output in markdown with these sections, in this exact order:

## Identity confidence
One short paragraph. State explicitly whether confidence is **HIGH** or **LOW** that the entity you researched is the subject above. Note disambiguators (same-name confusions, ambiguous signals, no public footprint, etc.).

If confidence is **LOW**, prepend the entire dossier with a disclaimer block immediately before the first heading:

> ⚠️ **LOW CONFIDENCE** — This dossier may not be about the intended subject. Sources were limited or ambiguous. See "Identity confidence" section below for details.

Always include the confidence assessment, even when HIGH. The literal word HIGH or LOW must appear in this section so a downstream parser can pick it up.

## Career snapshot
Current professional identity. Agency / representation. Location. Primary mediums (film, TV, theater, music, writing, directing, etc.).

## Body of work
Notable projects, collaborators, productions. Include dates and short context per item. List the most significant 10–20 if available.

## Recent activity (last 24 months)
Press, casting news, project announcements, public appearances, awards. Most-recent-first.

## Public-facing persona
What does their public voice sound like? Which platforms do they post on? What do they post about? Tone, recurring themes, public stances. Include follower scale if it's a meaningful signal.

## Tastes & interests
Personal signals from public sources: aesthetic preferences, music/film/book/art taste, communities and scenes they're part of, hobbies, admirations, mentors, values they articulate. Be specific and source each claim — generic guesses are worse than gaps.

## Gaps & uncertainty
Anywhere sources were thin, contradictory, or stale. What you'd want follow-up research on.

## Sources
All cited URLs grouped by section above.

Constraints:
- Public sources only. No leaked / scraped private data.
- Don't speculate where you don't have a source. Mark uncertainty in "Gaps & uncertainty" instead.
- If the subject appears to be deliberately private / low-profile online, say so — that's a valid finding, not a failure. Mark confidence accordingly and surface what little you do have.
- Surface what you find even when confidence is low; the consumer-side UI handles the disclaimer.
`;
}
