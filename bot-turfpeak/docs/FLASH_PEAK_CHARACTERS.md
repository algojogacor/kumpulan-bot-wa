# Flash Peak Character Roster & Attributes Specification

*Reverse engineered directly from Flash Peak Unity AssetBundles and game engine runtime dlls.*

**Source Bundles & Assemblies:**
- `bundle_to_modify\10ee363dd89953d507c7b97d19d20485\__data` (`FootballPlayerMainTable`, `FootballPlayerAttributeTable`, `PlayerRatingTable`, `FootballPlayerAbilityTable`)
- `table_outgame.bundle` (`Item`, `FootballPlayerPassiveSkillTable`, `FootballPlayerPassiveUnlock`, `FootballPlayerUpgrade`)
- `localization_zh-cn_strings.bundle`, `localization_en_strings.bundle`, `localization_id_strings.bundle`
- `ProjectCR.Runtime.dll` (`ProjectCR.Runtime.OutGame.Definition.CharacterDataConfigHelper`, `ProjectCR.Runtime.Gameplay.Definition`)

## 1. Executive Summary & Character Roster Overview

There are **14 total characters** defined in `FootballPlayerMainTable` (1 Template/Benchmark character ID 1000 and **13 official playable characters** IDs 1001–1013).

- **Item Rarity / Tier**: All playable avatar items belong to **Rarity 4 (Gold / 金色 / Legendary)**.
- **In-Game Match Rating Tiers** (from `PlayerRatingTable` & `RatingTier` enum):
  - **Low Tier (Bronze)**: Initial 6.0 baseline, minimum 3.0.
  - **Mid Tier (Silver)**: >= 6.0 (`ColorSilverThreshold`)
  - **High Tier (Gold)**: >= 7.5 (`ColorGoldThreshold`)
  - **Top Tier (Colorful / Rainbow)**: >= 9.0 (`ColorColorfulThreshold`), maximum 10.0.
  - Match Events: Goal (+0.55), Assist (+0.45), Pass (+0.14-0.16), Tackle (+0.19 / Key +0.36), Interception (+0.11 / Key +0.26), Block (+0.15 / Key +0.30), Shoulder Barge (+0.19 / Key +0.36), Over-possession penalty (-0.25 to -0.30).

### Character Summary Table

| ID | Avatar Item ID | Name (EN) | Name (ZH) | Name (ID) | Role / Pos | Gender | Base Rating Sum (L1) | Max Rating Sum (L20) | Ultimate Skill | Bot Enabled |
|---|---|---|---|---|---|---|---|---|---|---|
| 1000 | 101001000 | Template | 模板 | Template | ST | Male | 2500 | 2500 | None | FALSE |
| 1001 | 101001001 | Orion | 奥利恩 | Orion | ST | Male | 1777 | 1933 | Skyfall Kick | TRUE |
| 1002 | 101001002 | Hayato | 夜神隼 | Hayato | CM | Male | 1810 | 1962 | Flash Step | TRUE |
| 1003 | 101001003 | Andrew | 安德鲁 | Andrew | CB | Male | 1797 | 1949 | Anchor Sweep | TRUE |
| 1004 | 102001004 | Kelly | 凯莉 | Kelly | WF | Female | 1779 | 1935 | Ultra Velocity | TRUE |
| 1005 | 101001005 | Maxim | 马克西姆 | Maksim | GK | Male | 1965 | 1965 | None | TRUE |
| 1006 | 101001006 | Shirou | 士郎 | Shirou | ST | Male | 1796 | 1952 | Dual Impact | TRUE |
| 1007 | 101001007 | Rafael | 拉斐尔 | Rafael | ST | Male | 1746 | 1902 | Fake Shot Feint | FALSE |
| 1008 | 102001008 | Moco | 莫科 | Moco | CM | Female | 1789 | 1941 | Precision Protocol | TRUE |
| 1009 | 101001009 | Ford | 福特 | Ford | CB | Male | 1779 | 1931 | Iron Wall | TRUE |
| 1010 | 101001010 | Homer | 赫马 | Homer | CM | Male | 1801 | 1953 | Full Vision | TRUE |
| 1011 | 101001011 | Oscar | 奥斯卡 | Oscar | ST | Male | 1805 | 1961 | Savage Dash | TRUE |
| 1012 | 102001012 | Steffie | 史黛菲 | Steffie | CB | Female | 1784 | 1934 | Doodle Storm | FALSE |
| 1013 | 101001013 | Tatsuya | 达也 | Tatsuya | WF | Male | 1812 | 1968 | Shadow Shuttle | FALSE |

---

## 2. Core Attribute Engine & Radar Formula

Flash Peak character attributes are governed by a 2-tier hierarchy:
1. **Primary Radar Display Attributes (`AttributeType`, 1–6)**: Displayed on player cards and radar charts, calculated as the exact arithmetic mean of their component sub-attributes:
   - **DRI (Dribble / 控球)**: Average of `Dexterity` (1), `Balance` (2), `Dribble` (3), `TakeBall` (4).
   - **SHO (Shoot / 射门)**: Average of `ShootAccuracyFA` (5), `ShootHasBallStrength` (6), `ShootAccuracySA` (7), `ShootNoBallStrength` (8), `ShootAccuSpeed` (9), `ShootScrewStrength` (10).
   - **PAS (Pass / 传球)**: Average of `TapStrength` (11), `LobStrength` (12).
   - **DEF (Defense / 防守)**: Average of `ShootAccuracyTA` (13), `StandingTackle` (14), `Tackle` (15), `Plug` (16).
   - **PAC (Pace / Speed / 速度)**: Average of `SpeedRunHasBall` (18), `SpeedSprintHasBall` (19), `SpeedRunNoBall` (20), `SpeedSprintNoBall` (21), `SpeedDefense` (22).
   - **PHY (Physical / Physique / 体魄)**: Average of `Stamina` (23), `StaminaRecovery` (24), `Power` (25), `Scramble` (17).

### Primary Radar Attributes Comparison (Base Level 1)

| ID | Name | Pos | PAC (Pace) | SHO (Shoot) | PAS (Pass) | DRI (Dribble) | DEF (Def) | PHY (Physique) | Attribute Sum |
|---|---|---|---|---|---|---|---|---|---|
| 1000 | Template | ST | 100 | 100 | 100 | 100 | 100 | 100 | 2500 |
| 1001 | Orion | ST | 70 | 81 | 67 | 74 | 55 | 70 | 1777 |
| 1002 | Hayato | CM | 71 | 70 | 77 | 81 | 63 | 74 | 1810 |
| 1003 | Andrew | CB | 76 | 59 | 72 | 61 | 82 | 84 | 1797 |
| 1004 | Kelly | WF | 80 | 72 | 76 | 78 | 54 | 66 | 1779 |
| 1005 | Maxim | GK | 80 | 80 | 87 | 75 | 75 | 81 | 1965 |
| 1006 | Shirou | ST | 75 | 73 | 76 | 79 | 56 | 71 | 1796 |
| 1007 | Rafael | ST | 66 | 82 | 77 | 69 | 49 | 72 | 1746 |
| 1008 | Moco | CM | 76 | 67 | 78 | 77 | 61 | 72 | 1789 |
| 1009 | Ford | CB | 80 | 58 | 69 | 58 | 84 | 78 | 1779 |
| 1010 | Homer | CM | 70 | 73 | 84 | 74 | 60 | 75 | 1801 |
| 1011 | Oscar | ST | 75 | 73 | 71 | 75 | 58 | 77 | 1805 |
| 1012 | Steffie | CB | 81 | 55 | 78 | 59 | 79 | 78 | 1784 |
| 1013 | Tatsuya | WF | 81 | 67 | 70 | 74 | 71 | 71 | 1812 |

---

## 3. Detailed Character Catalog

### 1000 — Template (模板 / 上限)

- **Avatar Item ID**: `101001000` (Rarity: Gold / 4)
- **Position / Role**: `ST` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `FALSE` | **Active Switch**: `FALSE`

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 100 | 100 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 100 | 100 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 100 | 100 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 100 | 100 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 100 | 100 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 100 | 100 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 100 | 100 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 100 | 100 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 100 | 100 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 100 | 100 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 100 | 100 | |
| **Stamina** | Stamina Pool | `Stamina` | 100 | 100 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 100 | 100 | |
| **Power** | Physical Strength | `Power` | 100 | 100 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 100 | 100 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 100 | 100 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 100 | 100 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 100 | 100 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 100 | 100 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 100 | 100 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 100 | 100 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 100 | 100 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 100 | 100 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 100 | 100 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 100 | 100 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 100 | 100 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 100 | 100 | Ground slide |
| **Control** | Agility | `Dexterity` | 100 | 100 | Turn speed ratio |
| **Control** | Balance | `Balance` | 100 | 100 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 100 | 100 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 100 | 100 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **2500** | **2500** | Sum of base attributes |

#### Skills & Passives:



### 1001 — Orion (奥利恩 / Orion)

- **Avatar Item ID**: `101001001` (Rarity: Gold / 4)
- **Position / Role**: `ST` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Orion, a Striker (ST) who tears through tight spaces with lightning-fast bursts and delivers a finishing strike in the blink of an eye."*
- **Description (ZH)**: *"球员Orion，ST，以迅雷般的短距突破撕裂封锁，于电光火石之间轰出致命一击。"*
- **Official Illustration CDN**: [Orion Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryOrion.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 70 | 76 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 81 | 89 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 67 | 73 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 74 | 80 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 55 | 61 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 70 | 74 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 77 | 83 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 75 | 81 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 75 | 81 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 75 | 81 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 52 | 58 | |
| **Stamina** | Stamina Pool | `Stamina` | 72 | 78 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 69 | 75 | |
| **Power** | Physical Strength | `Power` | 67 | 73 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 73 | 73 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 69 | 75 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 65 | 71 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 86 | 94 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 82 | 90 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 78 | 86 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 83 | 91 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 84 | 92 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 74 | 82 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 59 | 65 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 52 | 58 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 49 | 55 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 62 | 68 | Ground slide |
| **Control** | Agility | `Dexterity` | 78 | 84 | Turn speed ratio |
| **Control** | Balance | `Balance` | 72 | 78 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 74 | 80 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 75 | 81 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1777** | **1933** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100102]**: **Skyfall Kick** (*拨云见日*) — *Behaviour: `OrionSuperShoot`*
- **Passive 1 [3001]**: **Low Bullet** (*低平射门*) — Increases low shot speed by 20%
- **Passive 2 [3003]**: **Box Predator** (*进攻嗅觉*) — Grants 2s of knockdown and interruption immunity when receiving the ball inside the opponent's box
- **Passive 3 [3018]**: **No Mercy** (*毫不留情*) — When the player's team scores a goal, the entire team gains 15 Ultimate Energy
- **Passive 4 [3024]**: **Flair Finisher** (*神来之笔*) — Always performs a Rabona shot when shooting while in possession near the opponent's box


### 1002 — Hayato (夜神隼 / Hayato)

- **Avatar Item ID**: `101001002` (Rarity: Gold / 4)
- **Position / Role**: `CM` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Hayato, a Central Midfielder (CM) who breaks past defenders with phantom-like footwork, stringing together quick bursts that no back line can contain."*
- **Description (ZH)**: *"球员Hayato，CM，双足如幻影起舞，任何防线都无法束缚他连续突破的步伐。"*
- **Official Illustration CDN**: [Hayato Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/Summaryhayato.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 71 | 77 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 70 | 76 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 77 | 83 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 81 | 89 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 63 | 69 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 74 | 79 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 71 | 77 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 75 | 81 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 70 | 76 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 71 | 77 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 69 | 75 | |
| **Stamina** | Stamina Pool | `Stamina` | 77 | 83 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 72 | 78 | |
| **Power** | Physical Strength | `Power` | 72 | 78 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 78 | 78 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 79 | 85 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 75 | 81 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 72 | 78 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 73 | 79 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 79 | 85 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 67 | 73 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 69 | 75 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 62 | 68 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 67 | 73 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 57 | 63 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 62 | 68 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 67 | 73 | Ground slide |
| **Control** | Agility | `Dexterity` | 82 | 90 | Turn speed ratio |
| **Control** | Balance | `Balance` | 78 | 86 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 82 | 90 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 84 | 92 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1810** | **1962** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100202]**: **Flash Step** (*翩若惊鸿*) — *Behaviour: `HayatoSuperDribble`*
- **Passive 1 [3005]**: **Untouchable Drag** (*卓越技巧*) — Reduces the chance of being dispossessed while using Skill Moves
- **Passive 2 [3006]**: **Thread the Needle** (*穿针引线*) — Increases ball speed by 10% when tapping a teammate to pass
- **Passive 3 [3007]**: **Comeback Drive** (*越挫越勇*) — For each goal the team is trailing by, the entire team gains 1 Ball Control and Shooting
- **Passive 4 [3025]**: **Trick Pass** (*花式出球*) — Increases Balance by 6. Enables immediate passing while performing Skill Moves or using an Ultimate.


### 1003 — Andrew (安德鲁 / 安德鲁)

- **Avatar Item ID**: `101001003` (Rarity: Gold / 4)
- **Position / Role**: `CB` (Back Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Official Illustration CDN**: [Andrew Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryAndrew.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 76 | 82 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 59 | 65 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 72 | 78 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 61 | 67 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 82 | 90 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 84 | 88 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 75 | 81 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 82 | 88 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 72 | 78 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 77 | 83 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 75 | 81 | |
| **Stamina** | Stamina Pool | `Stamina` | 84 | 90 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 83 | 89 | |
| **Power** | Physical Strength | `Power` | 87 | 93 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 83 | 83 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 72 | 78 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 72 | 78 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 52 | 58 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 72 | 78 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 52 | 58 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 52 | 58 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 72 | 78 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 57 | 63 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 81 | 89 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 83 | 91 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 83 | 91 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 84 | 92 | Ground slide |
| **Control** | Agility | `Dexterity` | 57 | 63 | Turn speed ratio |
| **Control** | Balance | `Balance` | 63 | 69 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 60 | 66 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 67 | 73 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1797** | **1949** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100302]**: **Anchor Sweep** (*超级铲球*) — *Behaviour: `AndrewSuperTackle`*
- **Passive 1 [3009]**: **Bulldog Slide** (*贴球旋铲*) — Automatically turns the body toward the ball when performing a Sliding Tackle
- **Passive 2 [3011]**: **Home Turf** (*积极防守*) — Reduces Stamina consumption by 30% while in own half
- **Passive 3 [3012]**: **Sticky Slide** (*粘性铲球*) — When a Sliding Tackle connects with no other opponents within 3m, there is a 60% chance to keep the ball at the player's feet
- **Passive 4 [3030]**: **Silent Zone** (*静默领域*) — Reduces nearby opponents' movement speed by 15% and Shooting by 10


### 1004 — Kelly (凯莉 / 凯莉)

- **Avatar Item ID**: `102001004` (Rarity: Gold / 4)
- **Position / Role**: `WF` (Front Field)
- **Gender**: `Female` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Official Illustration CDN**: [Kelly Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryKelly.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 80 | 86 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 72 | 80 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 76 | 82 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 78 | 84 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 54 | 60 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 66 | 70 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 79 | 85 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 87 | 93 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 77 | 83 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 85 | 91 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 72 | 78 | |
| **Stamina** | Stamina Pool | `Stamina` | 62 | 68 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 64 | 70 | |
| **Power** | Physical Strength | `Power` | 58 | 64 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 81 | 81 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 77 | 83 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 75 | 81 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 76 | 84 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 74 | 82 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 56 | 64 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 73 | 81 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 74 | 82 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 79 | 87 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 54 | 60 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 52 | 58 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 53 | 59 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 57 | 63 | Ground slide |
| **Control** | Agility | `Dexterity` | 78 | 84 | Turn speed ratio |
| **Control** | Balance | `Balance` | 77 | 83 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 80 | 86 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 79 | 85 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1779** | **1935** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100402]**: **Ultra Velocity** (*疾风壁影*) — *Behaviour: `KellyJumpWallDribble`*
- **Passive 1 [3014]**: **Swift Burst** (*灵动加速*) — Increases movement speed by 12% for 1.5s after knocking the ball forward
- **Passive 2 [3015]**: **Second Wind** (*二次追球*) — Instantly recovers 300 Stamina when dispossessed by a tackle
- **Passive 3 [3013]**: **Fluid Core** (*柔韧核心*) — Has a 50% chance to resist being knocked down when tackled
- **Passive 4 [3039]**: **Final Form** (*最终形态*) — Using an Ultimate increases all attributes by 9 for 30s


### 1005 — Maxim (马克西姆 / 马克西姆)

- **Avatar Item ID**: `101001005` (Rarity: Gold / 4)
- **Position / Role**: `GK` (Goalkeeper)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Official Illustration CDN**: [Maxim Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/Summarymaxim.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 80 | 80 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 80 | 80 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 87 | 87 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 75 | 75 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 75 | 75 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 81 | 81 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 75 | 75 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 75 | 75 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 75 | 75 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 75 | 75 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 100 | 100 | |
| **Stamina** | Stamina Pool | `Stamina` | 75 | 75 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 75 | 75 | |
| **Power** | Physical Strength | `Power` | 100 | 100 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 75 | 75 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 100 | 100 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 75 | 75 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 75 | 75 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 90 | 90 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 75 | 75 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 90 | 90 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 75 | 75 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 75 | 75 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 90 | 90 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 75 | 75 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 75 | 75 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 60 | 60 | Ground slide |
| **Control** | Agility | `Dexterity` | 75 | 75 | Turn speed ratio |
| **Control** | Balance | `Balance` | 75 | 75 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 75 | 75 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 75 | 75 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1965** | **1965** | Sum of base attributes |

#### Goalkeeper Specific Mechanics:

- **GoalKeeperShootAbility (`100501`)**: Goalkeeper goal-kick / long clearance.
- **GoalKeeperTapAbility (`100502`)**: Goalkeeper short ground roll/throw distribution.
- **GoalKeeperDiveAbility (`100503`)**: Goalkeeper diving save behavior (`UI_sikllicon_ultskill_gkdive`).
- **GoalKeeperTackleAbility (`100504`)**: Goalkeeper sliding sweep / challenge (`UI_sikllicon_ultskill_gkslide`).
- **Goalkeeper AI / Component Controllers**: `ProjectCR.Runtime.Gameplay.Component.AbilityBehaviourGoalKeeperTakeBall`, `PlayerAbilityBehaviourComponent::TrySelectGoalKeeperTakeBallAbility`.

#### Skills & Passives:



### 1006 — Shirou (士郎 / 士郎)

- **Avatar Item ID**: `101001006` (Rarity: Gold / 4)
- **Position / Role**: `ST` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Official Illustration CDN**: [Shirou Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryShirou.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 75 | 81 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 73 | 81 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 76 | 82 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 79 | 85 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 56 | 62 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 71 | 76 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 75 | 81 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 83 | 89 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 72 | 78 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 81 | 87 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 65 | 71 | |
| **Stamina** | Stamina Pool | `Stamina` | 69 | 75 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 72 | 78 | |
| **Power** | Physical Strength | `Power` | 71 | 77 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 75 | 75 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 77 | 83 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 75 | 81 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 72 | 80 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 78 | 86 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 66 | 74 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 70 | 78 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 71 | 79 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 81 | 89 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 53 | 59 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 53 | 59 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 51 | 57 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 67 | 73 | Ground slide |
| **Control** | Agility | `Dexterity` | 82 | 88 | Turn speed ratio |
| **Control** | Balance | `Balance` | 81 | 87 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 79 | 85 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 77 | 83 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1796** | **1952** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100602]**: **Dual Impact** (*双龙出海*) — *Behaviour: `ShirouDualShoot`*
- **Passive 1 [3003]**: **Box Predator** (*进攻嗅觉*) — Grants 2s of knockdown and interruption immunity when receiving the ball inside the opponent's box
- **Passive 2 [3002]**: **Relentless Strike** (*持之以恒*) — After the player's shot is saved by the goalkeeper, the player's next shot gains 30 Shot Power
- **Passive 3 [3017]**: **Power Bond** (*强化力量*) — Increases Shot Power by 15. This effect is shared with the teammate participating in Dual Impact.
- **Passive 4 [3018]**: **No Mercy** (*毫不留情*) — When the player's team scores a goal, the entire team gains 15 Ultimate Energy


### 1007 — Rafael (拉斐尔 / Rafael)

- **Avatar Item ID**: `101001007` (Rarity: Gold / 4)
- **Position / Role**: `ST` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `FALSE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Rafael, a Striker (ST) who lives for the goal and uses feints and fake shots to deliver the decisive finish for his team."*
- **Description (ZH)**: *"球员Rafael，ST，将球门位置刻入基因，在虚晃假射中为球队一锤定音。"*
- **Official Illustration CDN**: [Rafael Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryRafael.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 66 | 72 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 82 | 90 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 77 | 83 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 69 | 75 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 49 | 55 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 72 | 77 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 71 | 77 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 76 | 82 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 68 | 74 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 73 | 79 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 46 | 52 | |
| **Stamina** | Stamina Pool | `Stamina` | 67 | 73 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 66 | 72 | |
| **Power** | Physical Strength | `Power` | 75 | 81 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 82 | 82 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 78 | 84 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 76 | 82 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 85 | 93 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 85 | 93 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 79 | 87 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 82 | 90 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 82 | 90 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 79 | 87 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 49 | 55 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 49 | 55 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 48 | 54 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 51 | 57 | Ground slide |
| **Control** | Agility | `Dexterity` | 60 | 66 | Turn speed ratio |
| **Control** | Balance | `Balance` | 66 | 72 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 75 | 81 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 78 | 84 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1746** | **1902** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100702]**: **Fake Shot Feint** (*虚晃假射*) — *Behaviour: `RafaelSuperFakeShoot`*
- **Passive 1 [3027]**: **Skill Link** (*花式联动*) — Shooting immediately after Skill Moves increases ball speed by 8%
- **Passive 2 [3026]**: **Power Shot** (*大力射门*) — Increases shot speed by 10% and reduces ball drop during flight by 10%
- **Passive 3 [3037]**: **Meteor Stride** (*大步流星*) — Activating Dash grants an additional 10% speed boost and has a 20% chance not to consume a Dash charge
- **Passive 4 [3005]**: **Untouchable Drag** (*卓越技巧*) — Reduces the chance of being dispossessed while using Skill Moves


### 1008 — Moco (莫科 / Moco)

- **Avatar Item ID**: `102001008` (Rarity: Gold / 4)
- **Position / Role**: `CM` (Front Field)
- **Gender**: `Female` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Moco, a Central Midfielder (CM) who dictates the attacking tempo with deft short passes, pulls defenses apart through fluid passing and movement, and links the entire team into a rapid attacking force."*
- **Description (ZH)**: *"球员Moco，CM，以灵动短传牵引锋线节奏，于传跑交错之间撕开防线，并将全队串联成疾速推进的利刃。"*
- **Official Illustration CDN**: [Moco Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryMoco.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 76 | 82 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 67 | 73 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 78 | 84 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 77 | 85 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 61 | 67 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 72 | 77 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 72 | 78 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 80 | 86 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 76 | 82 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 77 | 83 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 75 | 81 | |
| **Stamina** | Stamina Pool | `Stamina` | 75 | 81 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 72 | 78 | |
| **Power** | Physical Strength | `Power` | 67 | 73 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 76 | 76 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 85 | 91 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 71 | 77 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 67 | 73 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 65 | 71 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 71 | 77 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 67 | 73 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 68 | 74 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 69 | 75 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 57 | 63 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 61 | 67 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 57 | 63 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 72 | 78 | Ground slide |
| **Control** | Agility | `Dexterity` | 80 | 88 | Turn speed ratio |
| **Control** | Balance | `Balance` | 76 | 84 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 81 | 89 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 72 | 80 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1789** | **1941** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100802]**: **Precision Protocol** (*黑客标记*) — *Behaviour: `MocoHackerMark`*
- **Passive 1 [3051]**: **Penetrating Short Pass** (*渗透短传*) — Passes to a locked-on teammate cannot be blocked for the first 0.3s
- **Passive 2 [3006]**: **Thread the Needle** (*穿针引线*) — Increases ball speed by 10% when tapping a teammate to pass
- **Passive 3 [3044]**: **Best Teammate** (*最佳队友*) — After passing to a teammate, their Shooting increases by 8 for 3s after receiving the ball
- **Passive 4 [3028]**: **Offensive Press** (*进攻压制*) — Grants more rear vision while dribbling


### 1009 — Ford (福特 / 福特)

- **Avatar Item ID**: `101001009` (Rarity: Gold / 4)
- **Position / Role**: `CB` (Back Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Official Illustration CDN**: [Ford Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/Summaryford.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 80 | 86 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 58 | 64 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 69 | 75 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 58 | 64 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 84 | 92 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 78 | 82 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 78 | 84 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 85 | 91 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 74 | 80 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 79 | 85 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 87 | 93 | |
| **Stamina** | Stamina Pool | `Stamina` | 80 | 86 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 79 | 85 | |
| **Power** | Physical Strength | `Power` | 79 | 85 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 75 | 75 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 70 | 76 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 69 | 75 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 53 | 59 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 77 | 83 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 47 | 53 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 47 | 53 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 77 | 83 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 52 | 58 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 86 | 94 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 89 | 97 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 81 | 89 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 81 | 89 | Ground slide |
| **Control** | Agility | `Dexterity` | 58 | 64 | Turn speed ratio |
| **Control** | Balance | `Balance` | 57 | 63 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 57 | 63 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 62 | 68 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1779** | **1931** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [100902]**: **Iron Wall** (*钢铁之墙*) — *Behaviour: `FordSuperBlock`*
- **Passive 1 [3022]**: **Precision Tackle** (*抢断高手*) — Automatically turns the body toward the ball when performing a Standing Tackle
- **Passive 2 [3033]**: **Auto Marking** (*自动跟防*) — Automatically marks opponents in front while in defensive stance
- **Passive 3 [3041]**: **Mobile Fortress** (*机动强固*) — Increases Blocking by 6. Increases movement speed by 15% while in defensive stance.
- **Passive 4 [3020]**: **Relentless Press** (*持续施压*) — Recovers 350 Stamina after a successful tackle


### 1010 — Homer (赫马 / Homer)

- **Avatar Item ID**: `101001010` (Rarity: Gold / 4)
- **Position / Role**: `CM` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Homer, a Central Midfielder (CM) who sees the whole pitch with exceptional vision and controls the middle and attacking third with pinpoint crosses."*
- **Description (ZH)**: *"球员Homer，CM，超级视野精准制导，以精妙传中控制整个中前场。"*
- **Official Illustration CDN**: [Homer Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryHomer.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 70 | 76 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 73 | 79 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 84 | 90 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 74 | 82 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 60 | 66 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 75 | 79 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 67 | 73 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 70 | 76 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 72 | 78 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 75 | 81 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 67 | 73 | |
| **Stamina** | Stamina Pool | `Stamina` | 79 | 85 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 72 | 78 | |
| **Power** | Physical Strength | `Power` | 72 | 78 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 78 | 78 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 83 | 89 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 85 | 91 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 69 | 75 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 75 | 81 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 79 | 85 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 67 | 73 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 69 | 75 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 81 | 87 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 59 | 65 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 57 | 63 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 65 | 71 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 61 | 67 | Ground slide |
| **Control** | Agility | `Dexterity` | 74 | 82 | Turn speed ratio |
| **Control** | Balance | `Balance` | 72 | 80 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 81 | 89 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 72 | 80 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1801** | **1953** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [101002]**: **Full Vision** (*全域视野*) — *Behaviour: `HomerMapStrike`*
- **Passive 1 [3044]**: **Best Teammate** (*最佳队友*) — After passing to a teammate, their Shooting increases by 8 for 3s after receiving the ball
- **Passive 2 [3029]**: **Aerial Guidance** (*空中制导*) — When using Lob Pass, ball speed increases by 5% and drop speed increases by 20%
- **Passive 3 [3031]**: **Sustained Vision** (*视野保持*) — Each pass or shot during Full Vision increases its duration by 4s
- **Passive 4 [3028]**: **Offensive Press** (*进攻压制*) — Grants more rear vision while dribbling


### 1011 — Oscar (奥斯卡 / Oscar)

- **Avatar Item ID**: `101001011` (Rarity: Gold / 4)
- **Position / Role**: `ST` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `TRUE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Oscar, a Striker (ST) who charges forward like a beast unleashed, barrels through defenders with unstoppable force, sends opponents flying, and finishes with a thunderous strike."*
- **Description (ZH)**: *"球员Oscar，ST，蓄势如猛兽出笼，以无可阻挡的冲锋碾碎拦截，奔袭之中撞飞敌手并轰出震撼一击。"*
- **Official Illustration CDN**: [Oscar Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummaryOscar.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 75 | 81 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 73 | 81 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 71 | 77 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 75 | 81 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 58 | 64 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 77 | 81 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 77 | 83 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 79 | 85 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 75 | 81 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 78 | 84 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 68 | 74 | |
| **Stamina** | Stamina Pool | `Stamina` | 78 | 84 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 75 | 81 | |
| **Power** | Physical Strength | `Power` | 78 | 84 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 77 | 77 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 70 | 76 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 73 | 79 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 74 | 82 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 78 | 86 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 68 | 76 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 74 | 82 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 76 | 84 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 71 | 79 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 52 | 58 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 67 | 73 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 57 | 63 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 59 | 65 | Ground slide |
| **Control** | Agility | `Dexterity` | 75 | 81 | Turn speed ratio |
| **Control** | Balance | `Balance` | 79 | 85 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 73 | 79 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 74 | 80 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1805** | **1961** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [101102]**: **Savage Dash** (*暴力奔袭*) — *Behaviour: `SavageDash`*
- **Passive 1 [3056]**: **Poacher's Instinct** (*门前抢点*) — Increases Ball-Winning by 6 inside either team's box
- **Passive 2 [3057]**: **Tight-Angle Expert** (*小角专家*) — Shots from tight angles travel 10% faster and drop more quickly
- **Passive 3 [3001]**: **Low Bullet** (*低平射门*) — Increases low shot speed by 20%
- **Passive 4 [3046]**: **Super Fitness** (*超人体能*) — Increases Shot Power by 10 for 3s after using Dash


### 1012 — Steffie (史黛菲 / Steffie)

- **Avatar Item ID**: `102001012` (Rarity: Gold / 4)
- **Position / Role**: `CB` (Back Field)
- **Gender**: `Female` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `FALSE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Steffie, a Center Back (CB) who sweeps away threats with swift, precise consecutive Sliding Tackles, anchors the back line, and turns the entire team into an ironclad counterattacking force."*
- **Description (ZH)**: *"球员Steffie，CB，以迅捷而精准的连续滑铲扫清威胁，既能守住后场阵地，也能令全队化作高速反击的钢铁锋线。"*
- **Official Illustration CDN**: [Steffie Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/SummarySteffie.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 81 | 87 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 55 | 61 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 78 | 83 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 59 | 65 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 79 | 87 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 78 | 82 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 79 | 85 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 86 | 92 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 76 | 82 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 80 | 86 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 87 | 93 | |
| **Stamina** | Stamina Pool | `Stamina` | 76 | 82 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 75 | 81 | |
| **Power** | Physical Strength | `Power` | 75 | 81 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 86 | 86 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 77 | 81 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 79 | 85 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 51 | 57 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 67 | 73 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 46 | 52 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 46 | 52 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 72 | 78 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 52 | 58 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 80 | 88 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 77 | 85 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 80 | 88 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 79 | 87 | Ground slide |
| **Control** | Agility | `Dexterity` | 56 | 62 | Turn speed ratio |
| **Control** | Balance | `Balance` | 62 | 68 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 55 | 61 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 63 | 69 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1784** | **1934** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [101202]**: **Doodle Storm** (*涂鸦风暴*) — *Behaviour: `SteffieDoodleBuff`*
- **Passive 1 [3034]**: **Steady Stride** (*冷静之靴*) — Using Dash has a 50% chance to reduce its cooldown by 3s
- **Passive 2 [3054]**: **Positioning Sense** (*抢点预判*) — The closer the player is to the ball during Ball-Winning, the greater the chance of winning possession
- **Passive 3 [3049]**: **Energy Shift** (*内能迁转*) — A teammate gains 10% movement speed for 3s after receiving the player's pass
- **Passive 4 [3011]**: **Home Turf** (*积极防守*) — Reduces Stamina consumption by 30% while in own half


### 1013 — Tatsuya (达也 / Tatsuya)

- **Avatar Item ID**: `101001013` (Rarity: Gold / 4)
- **Position / Role**: `WF` (Front Field)
- **Gender**: `Male` | **Height**: `1.8m` | **Push Radius**: `0.7`
- **Bot Allowed**: `FALSE` | **Active Switch**: `TRUE`
- **Description (EN)**: *"Tatsuya, a Wing Forward (WF) who slips into gaps like a shadow, wins possession with high-speed Dashes, and tears through the opposing defense with rapid changes of direction."*
- **Description (ZH)**: *"球员Tatsuya，WF，瞬身如影般突入空隙，以高速冲锋夺取球权，并在连续折向之间撕裂敌阵防守。"*
- **Official Illustration CDN**: [Tatsuya Illustration](https://cdn.cr.dhgamesdownload.com/common/OB3/Summarytatsuya.png)

#### Base Attributes (Level 1 vs Level 20 Max):

| Category | Attribute | Code Field | Base (L1) | Max (L20) | Notes |
|---|---|---|---|---|---|
| **Radar** | Pace / Speed (PAC) | Display PAC | 81 | 87 | Mean of 5 speeds |
| **Radar** | Shooting (SHO) | Display SHO | 67 | 75 | Mean of 6 shoot stats |
| **Radar** | Passing (PAS) | Display PAS | 70 | 76 | Mean of short/lob pass |
| **Radar** | Dribbling (DRI) | Display DRI | 74 | 80 | Mean of 4 dribble stats |
| **Radar** | Defense (DEF) | Display DEF | 71 | 77 | Mean of clearance/tackles/block |
| **Radar** | Physique (PHY) | Display PHY | 71 | 75 | Mean of stamina/power/scramble |
| **Speed** | Off-ball Run Speed | `SpeedRunNoBall` | 82 | 88 | |
| **Speed** | Off-ball Sprint Speed | `SpeedSprintNoBall` | 81 | 87 | |
| **Speed** | Dribble Run Speed | `SpeedRunHasBall` | 81 | 87 | |
| **Speed** | Dribble Sprint Speed | `SpeedSprintHasBall` | 82 | 88 | |
| **Speed** | Jockey / Defense Speed | `SpeedDefense` | 79 | 85 | |
| **Stamina** | Stamina Pool | `Stamina` | 78 | 84 | |
| **Stamina** | Stamina Recovery | `StaminaRecovery` | 72 | 78 | |
| **Power** | Physical Strength | `Power` | 59 | 65 | |
| **Power** | Ball Winning / Scramble | `Scramble` | 75 | 75 | 50/50 loose ball contest |
| **Pass** | Short Pass Power | `TapStrength` | 71 | 77 | Ground pass |
| **Pass** | Lob Pass Power | `LobStrength` | 69 | 75 | Aerial chipped pass |
| **Shoot** | Finishing Accuracy | `ShootAccuracyFA` | 64 | 72 | Inside-box accuracy |
| **Shoot** | Shot Power | `ShootHasBallStrength` | 66 | 74 | In-flight velocity |
| **Shoot** | Long Shot Accuracy | `ShootAccuracySA` | 64 | 72 | Outside-box accuracy |
| **Shoot** | Volleys Power | `ShootNoBallStrength` | 68 | 76 | One-touch volley strikes |
| **Shoot** | Charge Speed | `ShootAccuSpeed` | 66 | 74 | Meter charge rate |
| **Shoot** | Curve | `ShootScrewStrength` | 75 | 83 | Swerve & bend |
| **Defense** | Clearance | `ShootAccuracyTA` | 73 | 79 | Emergency boot clear |
| **Defense** | Blocking | `Plug` | 75 | 81 | Shot/cross interception block |
| **Tackle** | Standing Tackle | `StandingTackle` | 65 | 71 | On-feet interception |
| **Tackle** | Sliding Tackle | `Tackle` | 72 | 78 | Ground slide |
| **Control** | Agility | `Dexterity` | 75 | 81 | Turn speed ratio |
| **Control** | Balance | `Balance` | 78 | 84 | Stumble resistance |
| **Control** | Ball Control | `Dribble` | 73 | 79 | Dribble radius & retention |
| **Control** | First Touch | `TakeBall` | 71 | 77 | Ball trapping speed |
| **Total** | Total Attribute Sum | `Comment02` | **1812** | **1968** | Sum of base attributes |

#### Skills & Passives:

- **Ultimate Skill [101302]**: **Shadow Shuttle** (*疾影穿梭*) — *Behaviour: `TatsuyaSuperDash`*
- **Passive 1 [3037]**: **Meteor Stride** (*大步流星*) — Activating Dash grants an additional 10% speed boost and has a 20% chance not to consume a Dash charge
- **Passive 2 [3013]**: **Fluid Core** (*柔韧核心*) — Has a 50% chance to resist being knocked down when tackled
- **Passive 3 [3047]**: **Adaptability** (*随机应变*) — When the player's team is tied or leading, Stamina Recovery increases by 8. Otherwise, Shot Accuracy increases by 8.
- **Passive 4 [3032]**: **Quick Link** (*交互提速*) — After the player passes or shoots, teammates' off-ball response range increases by 15%

