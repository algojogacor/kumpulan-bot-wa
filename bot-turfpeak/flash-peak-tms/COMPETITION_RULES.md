# Flash Peak Tour — Competition Rules
## Organizer Review Draft v0.1

**Timezone:** WIB (`Asia/Jakarta`)  
**Status:** Proposed operational baseline; publish only after organizer approval.

## 1. General

1. Participants must follow the published schedule and official match instructions.
2. Each team appoints one official delegate.
3. Each division is a separate team entry and must have its own delegate.
4. The organizer is the final tournament authority, but material decisions must be recorded with a reason.
5. Gameplay is unrestricted unless a specific exploit, cheating method, or unfair manipulation is prohibited in the tournament announcement.
6. The game is not controlled by the tournament bot.

## 2. Roster

1. Minimum roster is five players: one goalkeeper and four outfield players.
2. Up to five substitutes may be registered.
3. Maximum roster is ten.
4. Registering only five players is permitted.
5. Every match lineup must contain five eligible players, including one goalkeeper.
6. Only registered roster members may play.
7. A player may represent only one team in the tournament.
8. Registered in-game nicknames must match the nickname used in the game.
9. Nickname changes during the tournament are prohibited.
10. Any discrepancy is referred to organizer review. A default score must not be applied automatically until the relevant evidence and rule are reviewed.
11. **Karakter Unik / Larangan Karakter Kembar (No Duplicate Characters):** Dalam satu tim, setiap pemain dilarang menggunakan karakter in-game yang sama dalam satu pertandingan (misalnya: dilarang menggunakan double Ford, double Moco, double Rafael, dll). Setiap pemain di tim wajib menggunakan karakter yang berbeda.
12. **Pemain Tidak Terdaftar / Pemain Gelap (Unregistered Player):**
    - Setiap tim wajib hanya memainkan pemain yang telah terdaftar resmi di roster turnamen.
    - **Jika Tim yang Memainkan Pemain Tidak Terdaftar MENANG atau SERI:** Kemenangan atau hasil seri tersebut otomatis **DIBATALKAN**. Pertandingan dinyatakan kalah Walkover (**WO 0–3**) untuk tim pelanggar (kemenangan WO 3–0 untuk tim lawan yang sah), dengan persetujuan 2 pihak (Panitia dan Tim Lawan) melalui `!approve`.
    - **Jika Tim yang Memainkan Pemain Tidak Terdaftar KALAH:** Skor asli pertandingan di lapangan **TETAP BERLAKU** (misalnya 7–1 tetap dicatat 7–1, tidak dipotong menjadi WO 3–0) demi menjamin keadilan tim pemenang yang sah agar selisih gol (GD) dan jumlah gol (GF) mereka tidak dirugikan. Namun, pemain tidak terdaftar tersebut ditetapkan berstatus `INELIGIBLE` (`is_award_eligible = 0`, tidak berhak atas penghargaan/statistik individu), dilarang bermain di match berikutnya, dan tim yang melanggar mendapatkan peringatan/teguran resmi panitia.

## 3. Competition format

MVP supports Traditional Group Stage followed by Knockout Stage. Swiss format is not used.

### 3.1 Group Stage
- One game per fixture.
- Confirmed duration: eight minutes.
- Draws are valid (for games actually played and genuinely tied in-game — see §6 for the distinct case of both teams unable to field a room).
- Win: 3 points.
- Draw: 1 point.
- Loss: 0 points.
- Registration is open with no cap on team count; every team contacting the bot is accepted.
- Groups are formed in batches of 5 teams. If the total team count is not evenly divisible by 5, the remainder is absorbed by sizing the last one or two groups at 4 instead of 5 (e.g. 23 registered teams → groups of 5, 5, 5, 4, 4). No group is ever smaller than 4 or larger than 5.
- Qualification: exactly the top 2 teams in every group advance to Knockout Stage — this is fixed regardless of whether that group has 5 teams or 4 teams.
- Round-robin: every team plays every other team in its own group exactly once (4 games per team in a 5-team group, 3 games per team in a 4-team group).
- The draw is randomized and revealed progressively by the bot.

### 3.2 Group tie-breakers
Proposed order:
1. Points.
2. Goal difference.
3. Goals scored.
4. Head-to-head points.
5. Head-to-head goal difference.
6. Head-to-head goals scored.
7. Playoff match or organizer procedure announced before it is needed.

### 3.3 Knockout
- All rounds before Grand Final: BO3.
- Grand Final: BO5.
- BO3: first to two game wins.
- BO5: first to three game wins.
- Each game score is recorded separately.
- A drawn individual KO game is replayed; the replay's result is added into the existing series score (e.g. series standing 2–1, next game ties, is replayed, and the replay's result brings the standing to 3–1 or 2–2) — the tied game does not consume a separate counted slot of its own.
- No drawn series.

## 4. Schedule defaults

These are configurable proposed defaults derived from the reference rulebook, not immutable product constants:
- Standard kickoff: 21:00 WIB.
- Schedule confirmation deadline: 20:00 WIB on matchday.
- Grace period: ten minutes after the mutually agreed/official kickoff.
- Proposed reporting target: within fifteen minutes after a game/series ends.
- Proposed game duration: eight minutes.

Teams should contact opponents promptly after fixtures are published. An agreed alternative time must be recorded by the system or approved by organizer.

## 5. Room host

The fixture identifies a default recommended room host: the team on the left side of the fixture. This is advisory, not a strict requirement.

Fairness rule: because the left-side team is the default host recommendation, fixture generation must spread left/right side assignment evenly across each team's own Group Stage fixtures (standard round-robin scheduling already does this), so no team is stuck always hosting — or always exempt from hosting — across the whole Group Stage. A team's side count across its fixtures in one group may differ by at most one left vs. right.
- If the designated host has no room card but the opposing team is willing to host instead, the match proceeds normally with the opposing team hosting.
- If the opposing team is unwilling to host in that situation, the opposing team wins the match by forfeit.
- If BOTH teams are unable to provide a room card (no host and no willing substitute host on either side): see §6 for Group Stage and Knockout handling — these are treated differently.

## 6. Walkover and attendance

Proposed defaults:
- Group Stage WO: 3–0, three points to winner.
- BO3 series forfeit: series loss 0–2.
- BO5 series forfeit: series loss 0–3.
- Administrative series score must not be confused with actual in-game goals.
- WO creates no player statistics.
- If both teams fail to appear, Group Stage default is double forfeit: zero points each and no player statistics.
- If both teams are unable to provide a room card (§5) — distinct from failing to appear at all — Group Stage treatment is the same double forfeit: zero points each, no player statistics. This is NOT the same as an in-game draw (which still earns 1 point each); no game was actually played, so draw policy does not apply.
- If both teams are unable to provide a room card in Knockout (BO3/BO5) — or both fail to appear — BOTH teams are declared LOSERS (double loss, revised 20 Nov 2026; previously mandatory reschedule). The fixture produces no winner, and the team scheduled to meet the winner of this fixture in the next round advances automatically without playing (bye). No player statistics are generated.
- Incomplete lineup means fewer than five eligible players including goalkeeper, subject to final confirmation of game substitution rules.

The 19:30 automatic WO claim from the reference rulebook is not adopted in this draft. Use the actual agreed kickoff and grace period.

## 7. Match evidence

### 7.1 Main screenshot
The main match-result screenshot is mandatory for the official score and multi-player statistics. Original/unmodified image is preferred.

### 7.2 Goalkeeper detail
The goalkeeper Individual Player Detail screenshot is supplementary:
- One individual only.
- The screen itself contains no nickname/UID — the game's detail view simply doesn't show one.
- Because of this, the submitting delegate MUST type the goalkeeper's nickname in the message text/caption that accompanies the screenshot (e.g. "FOTO 1 HX KINGrajj"). Approximate/fuzzy matches against the roster nickname are accepted; an exact match is not required.
- Visual goalkeeper cue: cap, goalkeeper gloves, ball held in front of abdomen/chest.
- Summary `DEFENSE` is treated as saves under organizer rule.
- The `DEFENSE` detail tab does not need to be opened for MVP.

### 7.3 Goalkeeper submission policy
- Group Stage: only winning team's goalkeeper/delegate submits.
- BO3/BO5: only goalkeeper/delegate of series-winning team submits after series ends.
- One detail screenshot is expected for each game WON by that team within the series — not one per game actually played. A lost game within the series is not submitted at all.
- Expected counts: BO3 always 2; BO5 always 3 — regardless of how the series finished (e.g. BO3 2–1 still submits only 2, not 3; BO5 3–2 still submits only 3, not 5).
- Because only won games are ever submitted, every goalkeeper detail record collected is award-eligible by construction; there is no ineligible/retained-but-excluded category under this policy.
- The caption nickname is used only to identify which goalkeeper on the submitting team's roster the screenshot belongs to (relevant if the team has a backup keeper registered) — it is never used to determine the team, since team identity is already fixed by the fact that only the winning team submits.

### 7.4 Submission completeness
A report may be marked incomplete if required main evidence or required goalkeeper evidence is missing. The bot must explain what is missing and allow organizer review.

## 8. Corrections and approvals

1. Team delegates can submit a correction in natural language, preferably as a reply to the report.
2. The bot interprets the correction but does not directly finalize it.
3. Both team delegates and organizer approve the same report version.
4. A correction after approval creates a new version and resets approvals.
5. Disputes are held for organizer review.
6. The audit trail is retained.

## 9. Technical incidents

1. If a confirmed in-game bug prevents a valid result, organizer may order a replay.
2. The replay replaces/invalidates the affected game record; it is not silently added as an extra game.
3. Evidence from abandoned games is retained but excluded from official stats.
4. AI outage does not invalidate a match; manual reporting is available.

## 10. Individual awards

Potential awards:
- Golden Boot.
- Top Assist.
- Best Playmaker.
- Best Defender.
- Best Winning Goalkeeper (provisional name due winner-only sample).
- MVP / Best Player.
- Team of the Tournament.

Award formula, confirmed: no weighted/composite formula. Each award is a simple ranking by its one defining captured metric — e.g. Golden Boot ranks by total goals, Top Assist by total assists, Best Defender by a defense-related captured metric, Best Winning Goalkeeper by `goalkeeper_saves` totals from award-eligible (i.e. won-game) records. Highest value wins. An exact tie on the defining metric is a co-winner situation unless the organizer rules otherwise for a specific award.

Award formulas and tie-breaks must be published before the competition begins. Do not rank players using metrics that are not captured consistently.

## 11. Organizer decisions

The organizer may resolve cases not explicitly covered, but must:
- Apply decisions consistently.
- Record the reason.
- Avoid retroactive rule changes to completed fixtures unless required to correct a clear administrative error.
- Communicate material rule changes before they take effect.
