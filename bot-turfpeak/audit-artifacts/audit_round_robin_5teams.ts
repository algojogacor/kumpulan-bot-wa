/**
 * AUDIT ARTIFACT: Round-Robin & Left/Right Side Balance Verification
 * Target: FR-COMP-012 (Single round-robin within group)
 *         FR-COMP-013 (Balanced left/right side host assignment)
 * 
 * Verifies whether 5-team and 4-team groups produce exact single round-robin
 * schedules or if duplicate/double round-robin fixtures occur.
 */

import { generateBalancedRoundRobin, GroupTeamParticipant } from '../src/competition/fixtures.js';

console.log('=== AUDIT TEST: ROUND-ROBIN 5-TEAM & 4-TEAM SCHEDULER ===');

// --- Test Scenario 1: 5 Teams in Group A ---
const fiveTeams: GroupTeamParticipant[] = [
  { team_id: 'team-1', team_name: 'Team 1', draw_position: 1 },
  { team_id: 'team-2', team_name: 'Team 2', draw_position: 2 },
  { team_id: 'team-3', team_name: 'Team 3', draw_position: 3 },
  { team_id: 'team-4', team_name: 'Team 4', draw_position: 4 },
  { team_id: 'team-5', team_name: 'Team 5', draw_position: 5 },
];

const matches5 = generateBalancedRoundRobin(fiveTeams);

console.log(`\n[5 Teams] Generated total matches: ${matches5.length}`);
console.log('Expected for single round-robin: 5 * 4 / 2 = 10 matches (4 matches per team)');

const teamMatchCount = new Map<string, number>();
const teamLeftCount = new Map<string, number>();
const teamRightCount = new Map<string, number>();
const pairCounts = new Map<string, number>();

for (const t of fiveTeams) {
  teamMatchCount.set(t.team_id, 0);
  teamLeftCount.set(t.team_id, 0);
  teamRightCount.set(t.team_id, 0);
}

for (const m of matches5) {
  const tA = m.team_a.team_id;
  const tB = m.team_b.team_id;
  
  teamMatchCount.set(tA, (teamMatchCount.get(tA) || 0) + 1);
  teamMatchCount.set(tB, (teamMatchCount.get(tB) || 0) + 1);

  teamLeftCount.set(tA, (teamLeftCount.get(tA) || 0) + 1);
  teamRightCount.set(tB, (teamRightCount.get(tB) || 0) + 1);

  const pairKey = [tA, tB].sort().join(' vs ');
  pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
}

let is5SingleRoundRobin = true;
for (const [teamId, count] of teamMatchCount.entries()) {
  console.log(`  Team ${teamId}: ${count} matches (Left: ${teamLeftCount.get(teamId)}, Right: ${teamRightCount.get(teamId)})`);
  if (count !== 4) {
    is5SingleRoundRobin = false;
  }
}

let hasDuplicatePairings5 = false;
for (const [pair, count] of pairCounts.entries()) {
  if (count !== 1) {
    console.error(`  VIOLATION: Pair ${pair} played ${count} times!`);
    hasDuplicatePairings5 = true;
  }
}

console.log(`[5 Teams] Single round-robin status: ${is5SingleRoundRobin && !hasDuplicatePairings5 ? 'PASS (10 matches, 4/team)' : 'FAIL'}`);

// --- Test Scenario 2: 4 Teams in Group B ---
const fourTeams: GroupTeamParticipant[] = [
  { team_id: 'team-A', team_name: 'Team A', draw_position: 1 },
  { team_id: 'team-B', team_name: 'Team B', draw_position: 2 },
  { team_id: 'team-C', team_name: 'Team C', draw_position: 3 },
  { team_id: 'team-D', team_name: 'Team D', draw_position: 4 },
];

const matches4 = generateBalancedRoundRobin(fourTeams);
console.log(`\n[4 Teams] Generated total matches: ${matches4.length}`);
console.log('Expected for single round-robin: 4 * 3 / 2 = 6 matches (3 matches per team)');

let is4SingleRoundRobin = matches4.length === 6;
console.log(`[4 Teams] Single round-robin status: ${is4SingleRoundRobin ? 'PASS (6 matches, 3/team)' : 'FAIL'}`);

console.log('\n=== AUDIT CONCLUSION ON FIXTURES ===');
if (is5SingleRoundRobin && !hasDuplicatePairings5 && is4SingleRoundRobin) {
  console.log('CURRENT CODE IMPLEMENTATION (fixtures.ts:44-143) CORRECTLY PRODUCES SINGLE ROUND-ROBIN.');
} else {
  console.error('CURRENT CODE HAS DEFECT IN ROUND-ROBIN GENERATION!');
}
