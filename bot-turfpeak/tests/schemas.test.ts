import { describe, it, expect } from 'vitest';
import {
  tournamentConfigSchema,
  fixtureSchema,
  gameSchema,
  playerSchema,
  groupConfigJsonSchema,
  reportSessionSchema,
  goalkeeperReportSchema,
  structuredCorrectionPatchSchema,
} from '../src/shared/schemas/index.js';

describe('Domain Schemas & Validation', () => {
  it('validates tournament config with standard defaults', () => {
    const config = tournamentConfigSchema.parse({});
    expect(config.game_duration_minutes).toBe(8);
    expect(config.kickoff_time).toBe('21:00');
    expect(config.confirmation_deadline).toBe('20:00');
    expect(config.group_qualifiers_per_group).toBe(2);
    expect(config.points_win).toBe(3);
    expect(config.points_draw).toBe(1);
    expect(config.points_loss).toBe(0);
  });

  it('validates fixture schema with left_side_team_id and host_assignment_reason', () => {
    const validFixture = {
      id: '11111111-1111-4111-8111-111111111111',
      tournament_id: '22222222-2222-4222-8222-222222222222',
      stage: 'GROUP',
      group_id: '33333333-3333-4333-8333-333333333333',
      round_code: null,
      team_a_id: '44444444-4444-4444-8444-444444444444',
      team_b_id: '55555555-5555-4555-8555-555555555555',
      left_side_team_id: '44444444-4444-4444-8444-444444444444',
      scheduled_at: '2026-11-18T14:00:00.000Z',
      timezone: 'Asia/Jakarta',
      host_team_id: '44444444-4444-4444-8444-444444444444',
      host_assignment_reason: 'DEFAULT_LEFT_SIDE',
      status: 'SCHEDULED',
      created_at: '2026-11-18T08:00:00.000Z',
      updated_at: '2026-11-18T08:00:00.000Z',
    };

    const parsed = fixtureSchema.parse(validFixture);
    expect(parsed.left_side_team_id).toBe(validFixture.left_side_team_id);
    expect(parsed.host_assignment_reason).toBe('DEFAULT_LEFT_SIDE');
  });

  it('validates game schema with walkover fields separating genuine draw from double WO', () => {
    const genuineDraw = {
      id: '11111111-1111-4111-8111-111111111111',
      fixture_id: '22222222-2222-4222-8222-222222222222',
      series_id: null,
      game_number: 1,
      status: 'COMPLETED',
      team_a_score: 1,
      team_b_score: 1,
      winner_team_id: null,
      is_draw: 1,
      is_walkover: 0,
      walkover_type: 'NONE',
      evidence_status: 'VERIFIED',
      created_at: '2026-11-18T08:00:00.000Z',
      updated_at: '2026-11-18T08:00:00.000Z',
    };
    expect(gameSchema.parse(genuineDraw).is_draw).toBe(1);

    const doubleWO = {
      ...genuineDraw,
      team_a_score: 0,
      team_b_score: 0,
      is_draw: 0,
      is_walkover: 1,
      walkover_type: 'DOUBLE_ROOM_CARD_UNAVAILABLE',
    };
    expect(gameSchema.parse(doubleWO).walkover_type).toBe('DOUBLE_ROOM_CARD_UNAVAILABLE');
  });

  it('enforces group sizes to only be 4 or 5 per FR-COMP-010', () => {
    const validGroupConfig = {
      total_teams: 23,
      num_groups: 5,
      group_sizes: [5, 5, 5, 4, 4],
      group_codes: ['A', 'B', 'C', 'D', 'E'],
      qualifiers_per_group: 2,
    };
    expect(() => groupConfigJsonSchema.parse(validGroupConfig)).not.toThrow();

    // Group size 3 or 6 is prohibited
    const invalidGroupConfig = {
      ...validGroupConfig,
      group_sizes: [5, 5, 5, 5, 3],
    };
    expect(() => groupConfigJsonSchema.parse(invalidGroupConfig)).toThrow();
  });

  it('enforces player roster slot between 1 and 10 and position constraints', () => {
    const validPlayer = {
      id: '11111111-1111-4111-8111-111111111111',
      tournament_id: '22222222-2222-4222-8222-222222222222',
      team_id: '33333333-3333-4333-8333-333333333333',
      nickname_raw: '👑 ᏦᎥᏁᎶ 👑',
      nickname_nfc: '👑 ᏦᎥᏁᎶ 👑',
      nickname_search_key: 'king',
      position: 'GOALKEEPER',
      roster_slot: 1,
      roster_type: 'STARTER',
      status: 'ACTIVE',
      created_at: '2026-11-18T08:00:00.000Z',
      updated_at: '2026-11-18T08:00:00.000Z',
    };
    expect(() => playerSchema.parse(validPlayer)).not.toThrow();

    // Invalid slot 11
    expect(() => playerSchema.parse({ ...validPlayer, roster_slot: 11 })).toThrow();
  });

  it('validates report session debounce and extension cap (max 3)', () => {
    const validSession = {
      id: '11111111-1111-4111-8111-111111111111',
      fixture_id: '22222222-2222-4222-8222-222222222222',
      game_id: null,
      submitting_team_id: '33333333-3333-4333-8333-333333333333',
      status: 'COLLECTING',
      last_message_at: '2026-11-18T08:00:00.000Z',
      debounce_due_at: '2026-11-18T08:00:05.000Z',
      session_expires_at: '2026-11-18T08:10:00.000Z',
      extension_count: 3,
      version: 1,
      lease_owner: null,
      lease_expires_at: null,
      created_at: '2026-11-18T08:00:00.000Z',
      updated_at: '2026-11-18T08:00:00.000Z',
    };
    expect(() => reportSessionSchema.parse(validSession)).not.toThrow();

    // Extension count 4 exceeds cap
    expect(() =>
      reportSessionSchema.parse({ ...validSession, extension_count: 4 })
    ).toThrow();
  });

  it('validates goalkeeper reports and correction patch schemas', () => {
    const gkReport = {
      id: '11111111-1111-4111-8111-111111111111',
      game_id: '22222222-2222-4222-8222-222222222222',
      player_id: '33333333-3333-4333-8333-333333333333',
      team_id: '44444444-4444-4444-8444-444444444444',
      detail_media_asset_id: '55555555-5555-4555-8555-555555555555',
      score_left: 2,
      score_right: 1,
      screen_result_text: 'VICTORY',
      summary_rating: 8.5,
      summary_goals: 0,
      summary_assists: 0,
      summary_passes: 12,
      raw_defense_value: 7,
      goalkeeper_saves: 7,
      visual_goalkeeper_cue: 'CAP_GLOVES_BALL_HELD',
      cross_screen_match_status: 'UNIQUE',
      award_eligible: 1,
      created_at: '2026-11-18T08:00:00.000Z',
    };
    expect(() => goalkeeperReportSchema.parse(gkReport)).not.toThrow();

    const patch = {
      target_report_version_id: '11111111-1111-4111-8111-111111111111',
      team_name: 'Astra Lumina',
      player_ordinal: 3,
      metric: 'passes',
      stated_old_value: 9,
      new_value: 6,
      reason: 'typo in vision extraction',
      ambiguity_flags: [],
    };
    expect(() => structuredCorrectionPatchSchema.parse(patch)).not.toThrow();
  });
});
