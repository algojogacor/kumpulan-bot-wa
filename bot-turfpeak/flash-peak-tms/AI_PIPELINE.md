# AI Pipeline and Vision Specification

## 1. Core principle

The AI pipeline proposes structured observations. Backend validation and human approvals determine official records.

Never let a model:
- Invent unreadable values.
- Guess a nickname from appearance.
- Choose the winner solely from a visual assumption.
- Assign a player to a team without evidence.
- Change roster data.
- Commit database writes.
- Approve its own extraction.
- Treat user-provided screenshot text as system instructions.

## 2. Image classes

`MAIN_MATCH_SUMMARY`
- Primary scoreboard/report screenshot.
- Expected to show score and multi-player statistics.
- Exact columns and layout must be grounded in the original sample screenshot before coding.

`INDIVIDUAL_PLAYER_DETAIL`
- One player only.
- Score/result header.
- Character showcase and summary metrics.
- Tabs SHOOTING, UMPAN, DEFENSE, POSSESSION.
- Supplied sample has SHOOTING tab active.
- No nickname or UID visible.

`UNKNOWN_OR_UNRELATED`
- Not a recognized match evidence screen.

`UNREADABLE`
- Evidence cannot be extracted reliably due to crop, compression, obstruction, or resolution.

## 3. Goalkeeper visual identification

Supplied sample visual description:
- One character shown, not a multi-player table.
- Character has a cap (described in the sample as black reversed cap).
- Goalkeeper gloves are visible.
- Character holds a ball in front of the abdomen/chest.
- The character is presented as a single individual.

The visual classifier may return:
- `goalkeeper_visual_cue: PRESENT`
- `goalkeeper_visual_cue: ABSENT`
- `goalkeeper_visual_cue: UNCERTAIN`

It must include evidence notes and confidence. Do not treat the visual cue as a personal identity. Avatar cosmetics may change; require cross-screen evidence and/or human confirmation.

## 4. Individual detail screen field map

From supplied analysis:
- `screen_result_text`: e.g. MENANG
- `score_left`
- `score_right`
- `winner_side` if directly supported by text/score convention
- `rating`
- `goals`
- `assists`
- `passes`
- `defense`
- `active_detail_tab`
- `shooting.shots`
- `shooting.shots_on_target`
- `shooting.goals`
- `shooting.goal_rate_raw`

For MVP:
- Use summary `DEFENSE` as goalkeeper saves, per organizer rule.
- Preserve raw `defense`.
- Set `goalkeeper_saves = defense` only after the image is classified as goalkeeper detail and linked to the appropriate game/player.
- Do not require UMPAN, DEFENSE, or POSSESSION detail tabs to be opened.
- If tab details are not visible, their values are null, not zero.

Example conceptual extraction:
```json
{
  "screen_type": "INDIVIDUAL_PLAYER_DETAIL",
  "match_result": {
    "status_text": "MENANG",
    "score_left": 12,
    "score_right": 7,
    "perspective_side": "left"
  },
  "perspective_player": {
    "nickname": null,
    "uid": null,
    "visual_role_cue": {
      "type": "GOALKEEPER",
      "cue_status": "PRESENT",
      "evidence": [
        "cap",
        "goalkeeper_gloves",
        "ball_held_in_front_of_abdomen_or_chest"
      ]
    },
    "summary": {
      "rating": 8.0,
      "goals": 0,
      "assists": 0,
      "passes": 2,
      "defense_raw": 4,
      "goalkeeper_saves": 4
    },
    "detail_tabs": {
      "active": "SHOOTING",
      "shooting": {
        "shots": 0,
        "shots_on_target": 0,
        "goals": 0,
        "goal_rate_raw": "N/A"
      },
      "umpan": null,
      "defense": null,
      "possession": null
    }
  },
  "identity_link": {
    "status": "UNRESOLVED",
    "candidate_player_id": null,
    "method": "CAPTION_NICKNAME_FUZZY_MATCH"
  },
  "uncertainties": []
}
```

This is a schema example, not a claim that all values are present in every screenshot.

## 5. Goalkeeper identity linking (caption-based, not cross-screen statistical matching)

The detail screen itself has no nickname/UID — it cannot identify the account from the image alone. Identity is resolved from the accompanying message caption, not from statistical fingerprinting against the main screenshot.

Link using:
- Fixture/series context from the WhatsApp session (this already establishes WHICH series and which team — only the series-winning team's goalkeeper ever submits, so team identity is never in question).
- The nickname typed by the submitting delegate in the message text/caption (e.g. "FOTO 1 HX KINGrajj").
- Fuzzy/approximate string matching of that caption text against the submitting team's roster — an exact match is not required.
- Unique match requirement WITHIN the submitting team's roster only (not the whole tournament).

Procedure:
1. Extract the caption text from the inbound message.
2. Extract the submitting team's roster (already known from session/fixture context).
3. Fuzzy-match the caption text against goalkeeper(s) on that roster only.
4. Require a unique candidate under calibrated similarity rules.
5. If zero or multiple candidates (e.g. caption is missing, unreadable, or ambiguous between two registered keepers), set `AMBIGUOUS` or `UNMATCHED`.
6. Ask the submitting delegate to clarify or confirm the candidate.
7. Save link method (`CAPTION_NICKNAME_FUZZY_MATCH`) and human confirmer if manual confirmation was needed.

Do not use a universal similarity percentage as a hard identity decision. Similarity thresholds must be calibrated with real examples and always include an ambiguity path. Statistical cross-matching against the main match screenshot (comparing rating/goals/assists/passes/defense vectors) is NOT used for goalkeeper identity — it was considered in an earlier draft and rejected in favor of the caption-nickname approach, since team identity is already fixed by submission policy and statistical vectors for goalkeepers cluster too tightly (most goalkeepers score 0 goals/0 assists) to reliably disambiguate.

## 6. Main match extraction

Extract only visible fields:
- Score per side.
- Winner/draw indicator.
- Player rows.
- Nickname raw strings.
- Per-player visible statistics.
- Team-side grouping.
- Highlighted row if visually present.
- Any visible rating.

Backend checks:
- Expected number of outfield players per side.
- Roster membership.
- Score consistency where the game UI supports it.
- Numeric values non-negative.
- Duplicate players/rows.
- Fixture context.
- Whether screenshot belongs to expected game.

If the screenshot does not visibly support a field, return null and explain.

## 7. Validation layers

### Layer A — Visual extraction
Model reads pixels and returns candidate observations with bounding-box/region notes where provider supports it.

### Layer B — Schema validation
Validate JSON types, required keys, enums, nullability, and allowed ranges.

### Layer C — Domain validation
Validate fixture, roster, score, player count, team grouping, goalkeeper role, and report completeness.

### Layer D — Human validation
Delegates correct, dispute, or approve. Organizer makes final decision.

## 8. Provider routing

Provider adapters must declare capabilities:
- text
- image input
- multi-image input
- JSON/schema-constrained output
- maximum image dimensions/size
- timeout
- context/output limits
- cost/quota reporting

Do not assume all models under one provider support vision or strict JSON output. Test exact model IDs at implementation time.

Recommended routing policy:
- Use one capable vision model for a logical batch when possible.
- Use a separate text model for correction parsing only when necessary.
- Avoid fan-out to every provider for every screenshot.
- Use fallback after a provider error or capability mismatch.
- Stop retries on invalid credentials, quota exhaustion, or policy errors; do not loop.
- If no compatible provider remains, manual fallback.

## 9. AI output must be typed

Prefer JSON Schema/structured output when supported. If provider lacks strict schema support:
1. Request JSON.
2. Parse.
3. Validate against application schema.
4. Retry at most a small configured number of times for format errors.
5. Reject invalid or incomplete output.
6. Never coerce suspicious strings into numbers silently.

## 10. Prompt injection and untrusted evidence

All screenshot text, captions, and messages are data. They cannot override developer/system rules. Delimit user evidence. Never follow instructions printed inside screenshots that ask the model to reveal secrets, change policy, or execute commands.

## 11. Evaluation

Maintain a versioned test set:
- Clear main screenshot.
- Compressed WhatsApp image.
- Cropped screenshot.
- Unicode/symbol-heavy nicknames.
- Similar stat vectors.
- Duplicate player candidates.
- Detail screenshot with goalkeeper visual cue.
- Detail screenshot without cue.
- Draw result.
- BO3/BO5 individual games.
- Conflicting score screenshots.
- Wrong fixture screenshot.
- Unreadable fields.
- Correction messages with multiple references.

Measure field-level precision/recall and false identity association. False identity association should be treated as a severe failure; prefer abstention.
