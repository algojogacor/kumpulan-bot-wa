# Testing and Evaluation Plan

## 1. Quality principles

- Prefer deterministic unit tests.
- Mock WhatsApp and AI provider boundaries.
- Keep a small, access-controlled golden screenshot dataset.
- Store expected values separately from prompts.
- Evaluate field-level accuracy and false identity matches.
- Test failure paths, not only happy paths.

## 2. Screenshot test matrix

### Main match summary
- Clear image.
- WhatsApp-compressed image.
- Rotated/cropped image.
- Partial occlusion.
- Low contrast.
- Unicode nickname with symbols.
- Similar nicknames.
- Duplicate-looking stat vectors.
- Score/result conflict.
- Draw.
- Incorrect number of visible players.

### Individual goalkeeper detail
- Reference goalkeeper avatar with cap, gloves, ball.
- Same screen with different score.
- Different active tab.
- SHOOTING active.
- UMPAN active if later captured.
- DEFENSE active if later captured.
- POSSESSION active if later captured.
- No visible goalkeeper cue.
- Blurred glove/ball.
- No nickname/UID.
- Duplicate stat vector in main summary.
- Multiple possible matching rows.

## 3. Extraction metrics

Track:
- Screen classification accuracy.
- Score exact-match accuracy.
- Nickname character exact-match accuracy.
- Per-stat exact-match accuracy.
- Null/abstention correctness.
- Goalkeeper cue precision/recall.
- Cross-screen link precision.
- False identity association count.
- JSON/schema validity.

False identity association is more serious than abstention. If uncertain, the correct behavior is to ask for manual confirmation.

## 4. Debounce tests

1. One message starts a five-second timer.
2. Second message at t+3 resets due time to t+8.
3. Third message at t+6 resets due time to t+11.
4. No processing occurs before t+11.
5. Processing starts once after quiet window.
6. Team A message does not reset Team B session.
7. Duplicate message key does not create duplicate evidence.
8. Worker restart preserves due time.
9. Race: new message arrives as worker claims batch; only latest complete batch is processed.
10. Late media is attached to the correct report session.

Use fake clocks; do not wait real five seconds in unit tests.

## 5. Draw tests

- Empty roster rejected.
- Incomplete onboarding rejected.
- Invalid group sizes rejected.
- Same participant snapshot yields stored immutable draw.
- Reveal one by one.
- Bot disconnect mid-reveal resumes correctly.
- Retry does not reroll.
- Manual override creates audit event.
- Shuffle distribution sanity test over many simulations.

## 6. Correction tests

Input:
“player urutan 3 salah di umpan, umpannya seharusnya 6 bukan 9, btw ini yang salah tim Astra Lumina ya”

Expected:
- Team Astra Lumina.
- Player ordinal 3 in the correct list.
- Metric passes.
- Old value 9.
- New value 6.
- If roster order ambiguous, ask clarification.
- No database mutation before validation/confirmation.

Also test:
- Correction refers to wrong team.
- Player number omitted.
- Statistic unknown.
- Old value conflicts with current report.
- Sender not authorized.
- Multiple reports open.
- Correction after lock.

## 7. Approval tests

- Team A only: not official.
- Team A + Team B: not official.
- All three approve same version: lock.
- Correction after one approval: reset all approvals.
- Correction after all approvals: new version, old remains immutable.
- Unauthorized user cannot approve.
- Organizer override has reason and audit record.

## 8. Competition tests

- Group draw with even and odd team counts, including non-multiples-of-5 (e.g. 23 teams → verify exactly 5+5+5+4+4, not some other combination that still sums correctly).
- No group ever smaller than 4 or larger than 5, for any total team count from the practical minimum up to a large number (e.g. test 8, 9, 13, 17, 20, 23, 24, 25 teams).
- Qualifiers remain fixed at 2 per group regardless of whether that group has 5 or 4 teams.
- Round-robin completeness: in a 5-team group, every team plays exactly 4 games; in a 4-team group, every team plays exactly 3 games.
- Group standings and tiebreakers.
- Draw (genuine in-game tie) gives one point each.
- Both-teams-no-room-card in Group Stage gives ZERO points each (double walkover), not 1 point each — explicitly test this is distinguished from a genuine draw.
- Both-teams-no-room-card in Knockout records a DOUBLE LOSS (both teams lose, no winner, revised 20 Nov 2026) — not a walkover, not a draw, not a reschedule; the next-round pairing of that fixture advances via automatic bye (test the bye path end-to-end).
- Room host forfeit: designated host has no room card, opponent unwilling to substitute-host → opponent is awarded the win (test both directions — left-side team lacking a card, and right-side team lacking a card).
- Room host substitution: designated host has no room card, opponent willing to host → match proceeds normally with opponent hosting, no forfeit.
- Left/right side balance: for a full round-robin group (both 5-team and 4-team sizes), verify every team's left-side count vs. right-side count across its own fixtures differs by at most 1, never e.g. 3 lefts and 0 rights for a team with 3 group fixtures.
- Side assignment is fixed at fixture-generation time and does not change on retry/reprocessing (same guarantee as FR-COMP-006, applied to side assignment specifically).
- BO3 2–0 and 2–1.
- BO5 3–0, 3–1, 3–2.
- Series score differs from game goal score.
- Tied individual KO game is replayed and its result is ADDED into existing series score at the same game-number slot (not recorded as a new extra game past the series' normal game count). Explicitly test that a BO5 series with one tied-then-replayed game still ends with a valid 3-x final series score, not a score implying more games than the format allows.
- Walkover produces no individual stats.
- Double forfeit (teams fail to appear).
- Report session expiry: new objection within window extends it; after exactly 3 extensions, a 4th objection does NOT extend further and instead routes to organizer review.

## 9. Goalkeeper tests

- `DEFENSE` summary maps to `goalkeeper_saves` only after goalkeeper detail classification and player linking.
- Raw defense value is retained.
- Hidden DEFENSE tab is not hallucinated.
- Detail image with no caption/nickname text is flagged `UNMATCHED` and requires manual confirmation — it does NOT fall back to statistical cross-screen matching.
- Caption nickname that fuzzy-matches more than one goalkeeper on the submitting team's roster (e.g. a team with two registered keepers and similar nicknames) requires manual confirmation.
- Caption nickname with minor typos/abbreviations (e.g. "KINGraj" vs registered "KINGrajj") still resolves successfully via fuzzy match — this is a required-pass case, not an edge case to reject.
- Expected screenshot count equals the series' required WINNING-game count (BO3 always 2, BO5 always 3), not games played. Explicitly test BO3 2–1 (must reject a 3rd submitted screenshot or treat it as extraneous) and BO5 3–2 (must expect exactly 3, not 5).
- Only winning-series team's goalkeeper evidence is accepted; a submission attempt from the losing team's goalkeeper is rejected.
- Every stored goalkeeper record is award-eligible by construction (no ineligible state exists under the corrected policy) — test that `is_award_eligible`/`award_eligible` is never false for a successfully stored goalkeeper record.
- Goalkeeper statistical-vector clustering: construct a test case where two different teams' goalkeepers both show 0 goals/0 assists/similar passes+defense, and confirm the system does NOT attempt to disambiguate by statistics alone (since team identity already comes from submission policy, this should be a non-issue, but the test guards against a regression back to cross-screen matching).

## 10. Provider tests

Mock:
- timeout
- network unavailable
- rate limit
- quota exceeded
- invalid credentials
- malformed JSON
- unsupported image
- provider returns text instead of JSON
- provider refuses/does not complete
- image too large
- fallback provider succeeds
- all providers fail

No automated test should consume live free-tier quota by default.

## 11. Storage tests

- Upload preserves original bytes.
- SHA-256 matches.
- Media metadata stored in Turso.
- VM media service returns correct reference.
- Private media cannot be fetched without authorization.
- Missing file detected.
- Backup and restore verified.
- Temporary files cleaned safely.
