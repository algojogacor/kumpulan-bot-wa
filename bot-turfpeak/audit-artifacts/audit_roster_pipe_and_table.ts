/**
 * AUDIT ARTIFACT: Roster Parser Pipe '|' and Markdown Table Robustness
 * Target: FR-RO-003 (Unicode / clan tag preservation), Pipe character parsing
 * 
 * Tests both the deterministic parser parseRosterInput() and the AI prompt schema
 * against complex nicknames with pipe characters (e.g. "AVO | Zenyth") and
 * markdown table formatting.
 */

import { parseRosterInput } from '../src/application/tournament-commands.js';
import { ROSTER_EXTRACTION_PROMPT, rosterExtractionOutputSchema } from '../src/ai/prompts/roster.js';

console.log('=== AUDIT TEST: ROSTER PARSER PIPE & TABLE ROBUSTNESS ===');

// --- Test 1: Single-line with pipe clan tags and section divider pipes ---
const singleLine = '!roster Garuda FC GK: AVO | Zenyth | Inti: RRQ | Lemon, ONIC | Sanz, EVOS | Clover, BTR | Ryzen | Cadangan: Alter | Ego, Dewa | United';
const res1 = parseRosterInput(singleLine.replace(/^!roster\s*/i, ''));

console.log('\n[Test 1: Single-line with pipe clan tags & section pipes]');
console.log('Team Name:', res1.teamName);
console.log('GK Name:', res1.gkName);
console.log('Starters:', res1.starterList);
console.log('Subs:', res1.subList);

const t1Pass =
  res1.teamName === 'Garuda FC' &&
  res1.gkName === 'AVO | Zenyth' &&
  res1.starterList.length === 4 &&
  res1.starterList[0] === 'RRQ | Lemon' &&
  res1.subList.length === 2 &&
  res1.subList[0] === 'Alter | Ego';

console.log('Result Test 1:', t1Pass ? 'PASS' : 'FAIL');

// --- Test 2: Multiline with pipe clan tags ---
const multiline = `
Daftar Roster Singa FC
GK: AVO | Zenyth
Inti:
1. RRQ | Lemon
2. ONIC | Sanz
3. EVOS | Clover
4. BTR | Ryzen
Cadangan:
- Alter | Ego
- Dewa | United
`;
const res2 = parseRosterInput(multiline);

console.log('\n[Test 2: Multiline with pipe clan tags]');
console.log('Team Name:', res2.teamName);
console.log('GK Name:', res2.gkName);
console.log('Starters:', res2.starterList);
console.log('Subs:', res2.subList);

const t2Pass =
  res2.gkName === 'AVO | Zenyth' &&
  res2.starterList.length === 4 &&
  res2.starterList[0] === 'RRQ | Lemon';

console.log('Result Test 2:', t2Pass ? 'PASS' : 'FAIL');

// --- Test 3: Markdown Table Input with pipe columns ---
const markdownTable = `
Roster Tim Elang
| No | Posisi | Nickname |
|---|---|---|
| 1 | GK | AVO | Zenyth |
| 2 | Inti | RRQ | Lemon |
| 3 | Inti | ONIC | Sanz |
| 4 | Inti | EVOS | Clover |
| 5 | Inti | BTR | Ryzen |
| 6 | Cadangan | Alter | Ego |
`;

const res3 = parseRosterInput(markdownTable);

console.log('\n[Test 3: Markdown Table parsed by deterministic parseRosterInput]');
console.log('Is Registration:', res3.isRegistration);
console.log('Team Name:', res3.teamName);
console.log('GK Name:', res3.gkName);
console.log('Starters:', res3.starterList);
console.log('Subs:', res3.subList);

const t3DeterministicPass =
  res3.gkName === 'AVO | Zenyth' &&
  res3.starterList.length === 4;

console.log('Result Test 3 (Deterministic):', t3DeterministicPass ? 'PASS' : 'FAIL (Deterministic parser cannot parse raw markdown table cells cleanly)');

// --- Test 4: Verify AI Roster Prompt Guidelines for Markdown Table / Pipes ---
console.log('\n[Test 4: AI Roster Extraction Prompt Analysis]');
const systemPrompt = ROSTER_EXTRACTION_PROMPT.system_prompt;
const hasPipeRule = systemPrompt.includes("NEVER SPLIT A PLAYER NAME ON PIPE '|'");
console.log("System Prompt contains rule: NEVER SPLIT A PLAYER NAME ON PIPE '|' ->", hasPipeRule ? 'YES (PASS)' : 'NO (FAIL)');

console.log('\n=== AUDIT CONCLUSION: ROSTER PIPE PARSING ===');
console.log(`- Deterministic single-line and multiline with clan tags: ${t1Pass && t2Pass ? 'MATURE' : 'DEFECT'}`);
console.log(`- Deterministic markdown table parsing: ${t3DeterministicPass ? 'MATURE' : 'GAP: Raw markdown tables with pipe columns require AI extractor (RosterExtractor) to parse reliably, deterministic parser extracts table syntax debris.'}`);
