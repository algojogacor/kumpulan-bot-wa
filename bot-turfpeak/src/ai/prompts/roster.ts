/**
 * Flash Peak TMS - AI Roster Parser Prompt & Schema
 * 
 * Prompt ID: roster_extractor_v1
 * Version: 1.0.0
 * Task: PARSE_ROSTER
 */

import { z } from 'zod';

export const rosterExtractionOutputSchema = z.object({
  team_name: z.string().nullable().default(null),
  gk_name: z.string().nullable().default(null),
  starter_list: z.array(z.string()).default([]),
  sub_list: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  uncertainties: z.array(z.string()).default([]),
});

export type RosterExtractionOutput = z.infer<typeof rosterExtractionOutputSchema>;

export const ROSTER_EXTRACTION_PROMPT = {
  prompt_id: 'roster_extractor_v1',
  version: '1.0.0',
  task: 'PARSE_ROSTER' as const,
  system_prompt: `You are an accurate, careful text parser for Flash Peak esports tournament team rosters.
Your job is to parse team roster registrations submitted via WhatsApp chat messages in either formal or informal formats.

TEAM ROSTER STRUCTURE:
- Team Name: The name of the esports team (e.g., "Garuda FC", "AVO Esports").
- Goalkeeper (GK / Kiper): Exactly 1 player designated as goalkeeper / kiper / slot 1.
- Starters (Inti / Outfield): The starting lineup outfield players (slots 2-5, typically 4 players).
- Substitutes (Cadangan / Subs): The substitute or reserve players (up to 3 players, Format 5+3: 1 GK, 4 Starters, max 3 Substitutes).

CRITICAL RULES FOR ESPORTS PLAYER NAMES:
1. Preserve every player nickname exactly as written, including Unicode characters, decorative glyphs (e.g. 〆, 么, 彡, ★, 丨), punctuation, spaces, and clan tags.
2. Clan tags frequently use the pipe character '|' or hyphens (e.g. "AVO | Zenyth", "RRQ | Lemon", "ONIC - Sanz", "EVOS | Clover", "BTR・Ryzen").
   NEVER SPLIT A PLAYER NAME ON PIPE '|' OR HYPHEN. Each line or designated entry is a single player name and must never be split by '|'.
3. If names are listed one per line (even without numbers or bullets), each line represents ONE full player name.
4. Clean prefix numbers or bullets (e.g., "1. PlayerA" -> "PlayerA", "- PlayerB" -> "PlayerB"), but DO NOT remove clan prefixes or pipes that are part of the player's in-game nickname.
5. If no explicit "Inti" or "Starter" keyword is present, but players are listed after the team name and goalkeeper (or numbered 1 to 4/5), interpret the non-GK players as starters first, and any subsequent players as substitutes.
6. If a player is marked with "(GK)" or "(Kiper)" anywhere in the text or list, assign them as gk_name.
7. Return null for team_name or gk_name if they cannot be determined.

OUTPUT FORMAT:
Return ONLY valid JSON matching this schema:
{
  "team_name": string or null,
  "gk_name": string or null,
  "starter_list": ["player1", "player2", ...],
  "sub_list": ["sub1", "sub2", ...],
  "confidence": number between 0 and 1,
  "uncertainties": ["observation notes if any"]
}`,
  buildUserPrompt: (rawText: string): string => {
    return `Extract the team name, goalkeeper, starters, and substitutes from the following tournament roster message:\n\n<message>\n${rawText}\n</message>`;
  },
};
