# Flash Peak Character Skills, Abilities, and Mechanics Specification
**Authoritative Reverse-Engineering Reference**

---

## 1. Executive Summary & Engine Architecture

Flash Peak character mechanics run on an authoritative physics-and-state-machine engine implemented in `ProjectCR.Runtime.dll` and `ProjectCR.CoreUnity.Runtime.dll`.
Key mechanical principles uncovered from runtime inspection:
- **Energy Pool (Ultimate Resource)**: Base max energy ($EnergyMaxA$) exactly matches the character's Ultimate cost (ranging from **280** for Homer to **530** for Orion). Outfield characters generate passive energy at **3.0 energy/sec** plus discrete energy recovery on successful actions (tackles, shots, passes, shoulder barges) governed by `FootballPlayerRecoverEnergyTable`.
- **Stamina Pool (Common & Small Skill Resource)**: Scaled between **600.0** ($StaminaAMin$) and **1200.0** ($StaminaAMax$). Regenerates at **320.0 to 450.0 stamina/sec**. Running with the ball drains **80.0 stamina/sec** (`RunHasBallStaminaCost`). Running off the ball costs 0 stamina.
- **Sprint Speed Curve**:
  - Off-ball run: 3.8 – 5.2 m/s; Off-ball sprint: 5.2 – 7.3 m/s.
  - With-ball run: 3.5 – 4.8 m/s; With-ball sprint: 4.8 – 6.8 m/s.
  - Defense / Jockey speed: 4.2 – 6.5 m/s.
  - Max passing target range: **35.0 meters** with **60° auto-select half-angle**.

---

## 2. Common & Universal Skills Dissection

| Skill ID | Name / Key | Behaviour Type | Resource Cost | Cooldown | Casting Condition | Tactical Effects & Mechanics |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **100007** | **Sprint** (`T_GR2_X_IG_NSPRINT`) | `Sprint` | None (0) | None | Movement active | Accelerates player to sprint speed (up to 7.3 m/s off-ball, 6.8 m/s with ball). Dribble with ball drains 80 stamina/sec. |
| **100005** | **Tackle** (`T_GR2_X_IG_NTACKLE`) | `Tackle` | **380 Stamina** | None | Off-ball | Ground sliding tackle. Knocks down opponent ball carrier, splits ball from feet, and triggers tackle recovery window. |
| **100006** | **Standing Tackle** (`T_GR2_X_IG_NSTACKLE`) | `StandingTackle` | **100 Stamina** | None | Off-ball | Quick standing interception / poke tackle. Steals ball without going to ground; low recovery latency. |
| **100004** | **Pull Ball** (`T_GR2_X_IG_NPULL`) | `PullBall` | **190 Stamina** | None | In possession | Directional drag-back move. Dodges incoming slide tackles and cancels pre-shooting/pre-passing animations. |
| **100003** | **Push Ball** (`T_GR2_X_IG_NPUSH`) | `PushBall` | **150 Stamina** | None | In possession | Powerful knock-on burst in any direction to break away from pressing defenders into open space. |
| **100301** | **Shoulder Barge** (`T_GR2_X_IG_NSHOULDER`) | `ShoulderBarge` | **400 Stamina** | None | Within **2.0m** range | Physical body charge comparing attacker vs defender Power attribute (`PlayerBeShoulderBargeTransition`). Can knockdown and dispossess. |
| **100009** | **Request Ball** (`T_GR2_X_IG_CALLBALL`) | `RequestBall` | None (0) | **3.5s** (`StartAfterUse`) | Off-ball | Calls AI/teammates for pass. Applies Buff `1002` (5.0s duration) signaling player intent and animates calling gesture. |
| **1001** | **SpeedUp** (`T_GR3_X_IG_NDASH`) | `SpeedUp` | **1 AbilityPoint** | None | Any | Applies Buff `1004` (Duration: **1.70s**, tag `SpeedUp`), boosting player velocity to maximum nitro speed. |
| **100008** | **Defend / Jockey** (`T_GR2_X_IG_NDEFEND`) | `Defend` | None (0) | None | Off-ball | Defensive stance locking camera and posture toward ball carrier, increasing balance and interception hitboxes. |

---

## 3. Shoulder Barge Mechanics & Mathematical Model

Shoulder Barge behavior is governed strictly by the transition table `PlayerBeShoulderBargeTransition.txt`:
$$\Delta 	ext{Power} = 	ext{Attacker Power} - 	ext{Target Power}$$

### Detailed Transition Rules & Probabilities

| Target State | Power Difference ($\Delta 	ext{Power}$) | Impact Angle ($	heta$) | Success Rate | Ball Release (`KickBall`) | Target Outcome / Animation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Running / Sprinting** | $\Delta 	ext{Power} > 25$ | 45°–160° (NW) or 200°–315° (NE) | **100%** | **Yes (1)** | **80% FALL DOWN (KNOCKDOWN)** (`Stumble_S2_FallDown`), **20% Slow Down** |
| **Running / Sprinting** | $\Delta 	ext{Power} > 25$ | 315°–45° or 160°–200° (Front/Back) | **100%** | **Yes (1)** | **80% Heavy Stumble** (`Stumble_S2`), **20% Slow Down** |
| **Running / Sprinting** | $10 < \Delta 	ext{Power} \le 25$ | All angles (0°–360°) | **70%** | **Yes (70%)** / **No (30%)** | **70% Slow Down & Dispossess**, **30% Protect Ball** (`ProtectBall` - Barge Fails) |
| **Running / Sprinting** | $-1 \le \Delta 	ext{Power} \le 10$ | All angles (0°–360°) | **40%** | **Yes (40%)** / **No (60%)** | **40% Slow Down & Dispossess**, **60% Protect Ball** (Barge Fails) |
| **Idle / Standing Still** | $\Delta 	ext{Power} > 10$ | All angles (0°–360°) | **100%** | **Yes (1)** | **100% Stumble** (`Stumble_S0_S_Stumble` / `Stumble_S1`), Ball Dispossessed |
| **Idle / Standing Still** | $-1 \le \Delta 	ext{Power} \le 10$ | All angles (0°–360°) | **20%** | **Yes (20%)** / **No (80%)** | **20% Stumble**, **80% Protect Ball** (Target shields ball) |
| **Any State** | $\Delta 	ext{Power} < -1$ | All angles (0°–360°) | **0%** | **No (0)** | **100% Protect Ball** (Target completely withstands charge) |

> **Power Hierarchy Impact**: Andrew (87 Power) barging Kelly (58 Power) results in $\Delta 	ext{Power} = +29$, guaranteeing **80% Knockdown**. Kelly barging Andrew results in $\Delta 	ext{Power} = -29$, resulting in a **0% success rate**.

---

## 4. Ability State Transitions & Animation Cancelling

Extracted from `AbilityTransition.txt`:
1. **`ShootPre` $ightarrow$ `PullBall` (Allowed = 1)**: Players can cancel shooting charge/windup directly into a drag-back (`PullBall`), faking out defenders and goalkeepers.
2. **`TapPre` $ightarrow$ `PullBall` (Allowed = 1)**: Passing charge can be cancelled into a drag-back.
3. **`TacklePre` $ightarrow$ `Shoot` (1), `Tap` (1), `Tackle` (1)**: Sliding tackle recovery/animation can transition into a quick shot, pass, or consecutive tackle (utilized by Steffie's Dual Slide).
4. **`StrikePre` $ightarrow$ `Shoot` (Allowed = 1)**: Striking stances can chain into direct shooting.
5. **`HitPre` (Stun / Stumble)**: **All actions blocked (0)**. Players cannot shoot, pass, tackle, pull, or barge while stunned.

---

## 5. Character Kits, Abilities, Ranges & Tactical Effects

### 1. Andrew (安德鲁) — CB (Center Back)
- **Base Stats (Lvl 1)**: Power = **87** (Highest outfield physical strength), Stamina = 84, Max Energy = **420**.
- **Ultimate Skill (Type 1)**: `100302` — **AndrewSuperTackle (超级铲球 / Super Tackle)**
  - **Resource Cost**: **420 Energy** | Cooldown: None.
  - **Casting Condition**: `T_GR3_Z_ABIHINT_NOBALL` (Must be off the ball; prohibited in opponent's penalty box).
  - **Range / Distance**: **18.0 METERS** (`FPParam01 = 18.0`).
  - **Buffs Applied**: Buff `1003010` (Area Check, 2.0s), Buff `1003020` (Tag `Active1003020`, 3.0s).
  - **Tactical Effects**: Andrew launches a ferocious 18-meter rocket slide tackle directly toward the ball carrier. On contact, opponent is knocked down, and Andrew **immediately takes control of the ball at his feet** (`ControlBallImmediately`), turning defense into an instant counter-attack. Recovers **+20 Energy** on success.
- **Small Skill / DefendLeft (Type 2)**: `100301` — **ShoulderBarge (冲撞)**
  - **Resource Cost**: **400 Stamina** | Range: **2.0m** (`FPParam01 = 2.0`).
  - **Tactical Effects**: Utilizes his 87 Power to easily achieve $\Delta 	ext{Power} > 25$, knocking opponents to the turf and kicking the ball loose.
- **Passives & Aura**:
  - `3009` (Tackle auto-turn toward ball direction).
  - `3011` (Solid as a rock).
  - `3012` (**Intimidation Aura**): Emits Buff `30300`, reducing nearby opponent movement speed and shooting attributes by **10 points**!

---

### 2. Ford (福特) — CB (Center Back)
- **Base Stats (Lvl 1)**: Power = **79**, Stamina = 80, Max Energy = **380**.
- **Ultimate Skill (Type 1)**: `100902` — **FordSuperBlock (超级阻挡 / Super Block)**
  - **Resource Cost**: **380 Energy** | Cooldown: 1.0s re-click interval (`FPParam01 = 1.0`).
  - **Casting Condition**: `T_GR3_Z_ABIHINT_NOBALL` (Must be off the ball; blocked during `HitPre`).
  - **Buffs Applied**: Buff `1009020` (Duration: **4.00 SECONDS**, adds tag `SuperBlock1009`), Buff `1009021` (Activation VFX, 4.0s).
  - **Tactical Effects (Lane Blockage & Auto-Clearance)**: Ford enters an impenetrable defensive iron stance for 4.0 seconds. Any incoming shot or pass crossing his defensive zone is automatically intercepted (`OnSuperBlockReceiveBall`), stopped dead (`StopFreeMoveBall`), and cleared with a thunderous kick back into the opposing half!
- **Small Skill / DefendLeft (Type 2)**: `100301` — **ShoulderBarge (冲撞)**
  - **Resource Cost**: **400 Stamina** | Range: **2.0m**.
- **Defensive Kit**: SimpleSkill PullBall (`100004`, 190 Stamina), Tackle (`100005`, 380 Stamina, +20 Energy recovery), Standing Tackle (`100006`, 100 Stamina, +20 Energy recovery).
- **Passives**: `3022` (Tackle Master), `3033` (Deep Defense), `3041` (Iron-Blood Defense), `3020` (Goal Iron Gate).

---

### 3. Orion (奥利安) — ST (Striker)
- **Base Stats (Lvl 1)**: Power = 67, Stamina = 72, Max Energy = **530**.
- **Ultimate Skill (Type 1)**: `100102` — **OrionSuperShoot (飞天倒钩 / Bicycle Kick)**
  - **Resource Cost**: **530 Energy** | Cooldown: None.
  - **Casting Condition**: `T_GR3_Z_ABIHINT_HASBALL` (In possession or loose ball within pick-up range).
  - **Buffs Applied**:
    - Buff `1001010` (Duration: **3.00s**, increases aerial scramble/contest value).
    - Buff `1001011` (Duration: **5.00s**, tags `Ball.BallDisableTackle`, `Ball.UlimateSkill` — **ball cannot be tackled**).
    - Buff `1001012` (Duration: **1.63s**, tag `Ball.BallDisableInteractive` — **ball cannot be intercepted mid-air**).
  - **Tactical Effects**: Orion flicks the ball skyward, leaps into the air, and executes an acrobatic bicycle kick. Players can **swipe the Ultimate button while casting to manually aim the trajectory** directly toward unprotected corners of the net. Immune to ground tackles.
- **Small Skill (Type 2)**: `100104` — **OrionPull (Orion拉球 / Signature Drag)**
  - **Resource Cost**: **320 Stamina** | Cooldown: None.
  - **Tactical Effects**: Signature evasive drag-back move with specialized arrow HUD (`UI_ingame_hud_skill_Arrow1`), dodging sliding tackles.
- **Passives**: `3001` (Low Bullet Pass), `3003` (Box Predator: grants **Super Armor** via Buff `30030` for 2.0s inside the penalty box), `3018` (Energy Recovery Buff `30180` for 2.0s), `3024`.

---

### 4. Hayato (夜神隼) — CM (Central Midfielder)
- **Base Stats (Lvl 1)**: Power = 72, Stamina = 77, Max Energy = **320**.
- **Ultimate Skill (Type 1)**: `100202` — **HayatoSuperDribble (极速连过 / Super Dribble)**
  - **Resource Cost**: **320 Energy** | Cooldown: None.
  - **Casting Condition**: `T_GR3_Z_ABIHINT_HASBALL` & `T_GR3_Z_ABIHINT_OPPCHK` (Opponents detected within sector).
  - **Range & Detection Cone**:
    - Forward push offset: **2.0 meters** along camera Yaw (`FPParam01 = 2.0`).
    - Detection Radius: **8.0 METERS** (`FPParam02 = 8.0`).
    - Sector Scan Angle: **120 DEGREES** arc (`FPParam03 = 120.0`).
  - **Tactical Effects**: Hayato performs lightning-fast chained dribble skill moves, slipping past up to **3 OPPONENTS IN A ROW** within the 8m 120° cone, completely freezing/bypassing defenders.
- **Small Skill (Type 2)**: `100204` — **HayatoPull (Hayato拉球)**
  - **Resource Cost**: **160 Stamina** (Discounted cost vs default 190).
  - **Tactical Effects**: Rapid directional pull-ball maneuver to evade incoming tackles and preserve momentum.
- **Passives**: `3005` (Super Armor Buff `30050` for 0.37s during dribble), `3006`, `3007` (Offensive attribute boost Buff `30070`), `3025`.

---

### 5. Kelly (凯莉) — WF (Wing Forward)
- **Base Stats (Lvl 1)**: Power = 58, Stamina = 62, Max Energy = **440**. Top-tier sprinting agility.
- **Ultimate Skill (Type 1)**: `100402` — **KellyJumpWallDribble (飞檐走壁 / Wall Dash)**
  - **Resource Cost**: **440 Energy** | Cooldown: None.
  - **Casting Condition**: `T_GR3_Z_ABIHINT_DISCHK` (Must be near the outer boundary wall while in possession).
  - **Spatial Parameters**:
    - Takeoff Distance to Wall: Up to **15.0 METERS** (`FPParam01 = 15.0`).
    - Wall Run Landing Extension: **8.0 METERS** forward (`FPParam02 = 8.0`).
    - Wall Jump Height: **1.8 METERS** vertical (`FPParam03 = 1.8`).
    - Goal Range Check Scale: **1.7x** (`FPParam04 = 1.7`).
  - **Tactical Effects**: Kelly leaps 1.8m up onto the arena perimeter wall and races forward along the wall at blazing speed with the ball, completely out of reach of ground tackles. At the conclusion of the wall run as she leaps down, tapping the button again chains into an **Aerial Volley Shot** (`HudKellyJumpWallShootInputCtrl`).
- **Small Skill (Type 2)**: `100003` — **PushBall (趟球 / Knock-On)**
  - **Resource Cost**: **150 Stamina** | Cooldown: None.
  - **Tactical Effects**: Large directional touch forward, allowing Kelly to exploit her sprint speed advantage.
- **Passives**: `3014` (Agile Acceleration: Buff `30140` grants +1.5s speed surge), `3015`, `3013` (Limit Sprint), `3039` (**Final Form**: Buff `30390` grants **+6% Move Speed and +3 to All Attributes for 30.0s**).

---

### 6. Shirou (士郎) — ST (Striker)
- **Base Stats (Lvl 1)**: Power = 71, Stamina = 69, Max Energy = **390**.
- **Ultimate Skill (Type 1)**: `100602` — **ShirouDualShoot (双人合体射门 / Dual Shoot)**
  - **Resource Cost**: **390 Energy** | Cooldown: None.
  - **Casting Condition**: `T_GR3_Z_ABIHINT_HASBALL` (In possession).
  - **Buffs & Timelines**:
    - Buff `1006020` (Dual Shoot Aura, Duration: **10.00s**, tag `Active1006020`).
    - Buff `1006022` (Power Enhance, Duration: **3.00s**, tag `ShirouUlimate`).
    - Buff `1006023` (Ball Buff, Duration: **10.00s**, tags `Ball.BallDisableTackle`, `Ball.UlimateSkill`).
    - Buff `1006025` (Teammate Assist Buff, Duration: **6.00s**, tag `Active1006021`).
    - Timeline StringParam01: `Stumble_HitFly_DoubleShoot_1006` (**HIT FLY / AERIAL KNOCKDOWN**).
    - Timeline StringParam02: `Stumble_HitRepel_DoubleShoot_1006` (Slide Repel).
  - **Tactical Effects (AoE Knockdown / Blaster Shot)**: Shirou calls a nearby teammate into a 10s combo link. When within range, both wind up together and release a twin shot. **Any opponent standing in the ball's trajectory is knocked down / blasted into the air**! Also supports an aerial variant (`DoubleShoot_CostarAir_1006`).
- **Small Skill (Type 2)**: `100604` — **Rainbow (彩虹过人 / Rainbow Flick)**
  - **Resource Cost**: **175 Stamina** | `FPParam01 = 1` (Aerial no-ball interaction).
  - **Tactical Effects**: Pops the ball over the defender's head into the air, bypassing sliding tackles and ground blocks.
- **Passives**: `3003` (Box Predator Super Armor), `3002` (Shot Power Boost `30020`), `3017` (Power Enhance `30170` 5.0s), `3018` (Energy Recovery `30180` 2.0s).

---

### 7. Rafael (拉斐尔) — ST (Striker)
- **Base Stats (Lvl 1)**: Power = 75, Stamina = 67, Max Energy = **460**.
- **Ultimate Skill (Type 1)**: `100702` — **RafaelSuperFakeShoot (假动作射门 / Super Fake Shoot)**
  - **Resource Cost**: **460 Energy** | Cooldown: None.
  - **Casting Condition**: `T_GR3_Z_ABIHINT_HASBALL` (In possession).
  - **Parameters**: `UIntParam01 = 2` (**2 successive fake shot charges**).
  - **Buffs Applied**: Buff `1007020` / `1007021` (Duration: **10.00s**, tag `SuperArmor`).
  - **Tactical Effects (Stun / Balance Loss & Unstoppable Power Shot)**: Enters a 10-second Super Armor fake shot stance controlled via left joystick. Nearby opponents who are not locked in defensive stance are **thrown off balance / stunned**. Tapping Shoot (`100703`) or Ult (`100705`) fires an explosive Power Shot. Recovers **+20 Energy** on loose-ball shots.
- **Small Skill (Type 2)**: `100704` — **CutTurn (磕球变向 / Cut Turn)**
  - **Resource Cost**: **250 Stamina** | Cooldown: None.
  - **Tactical Effects**: Sharp heel cut directed toward the goal while simultaneously aiming, snapping the ball's angle instantly.
- **Passives**: `3027` (Dribble Link: Buff `30270` grants **Shot Ball Speed Boost for 4.0s** after skill move), `3026` (Fake Move Master), `3037` (Lightning Raid), `3005` (Super Armor).

---

### 8. Moco (莫科) — CM (Central Midfielder)
- **Base Stats (Lvl 1)**: Power = 67, Stamina = 75, Max Energy = **380**.
- **Ultimate Skill (Type 1)**: `100802` — **MocoHackerMark (全域骇客标记 / Hacker Mark)**
  - **Resource Cost**: **380 Energy** | Cooldown: None.
  - **Buffs Applied**: Buff `1008020` & `1008021` (Duration: **20.00 SECONDS**, tags `Active1008020`, `SuppressEnergyRecovery`).
  - **Tactical Effects (Team-Wide Global Precision Passing)**: Grants **all teammates Precision Passing for 20 seconds**. The passing radar scans the **entire pitch (global range)**, bypassing field of view restrictions and auto-calculating optimal trajectory. Enables zero-cost sub-ability `100803` (`MocoHackerMarkTap`).
- **Small Skill (Type 2)**: `100804` — **FocusShortTap (撞墙二过一 / One-Two Pass)**
  - **Resource Cost**: **100 Stamina** | Cooldown: None.
  - **Range & Detection**:
    - 1st & 2nd pass scan radius: **25.0 METERS** (`FPParam01 = 25.0`).
    - Scan sector arc: **90 DEGREES** (`FPParam02 = 90.0`).
    - 3rd pass return scan radius: **50.0 METERS** (`FPParam03 = 50.0`).
  - **Buffs Applied**: Buff `1008040` (Target mark, 2.0s), Buff `1008041` (Duration: 2.0s, tags `DisableFocusDoor`, `DisableFocusBall` — blinds defender camera focus).
  - **Tactical Effects**: Moco pings a crisp short pass to a teammate up to 25m away; the teammate immediately first-time returns the ball into space as Moco accelerates past defenders.
- **Passives**: `3051` (Tactical Master / penetrating pass), `3006`, `3044` (Long Range Cannon: Buff `30440` grants **+8 Shot Power for 3.0s**), `3028`.

---

### 9. Homer (赫马) — CM (Central Midfielder)
- **Base Stats (Lvl 1)**: Power = 72, Stamina = 79, Max Energy = **280** (Cheapest Ult in the game!).
- **Ultimate Skill (Type 1)**: `101002` — **HomerMapStrike (全视之眼 / Full Vision)**
  - **Resource Cost**: **280 Energy** | Cooldown: 2.0s min cancel window (`FPParam01 = 2.0`).
  - **Buffs Applied**: Buff `1010020` (Duration: **60.00 SECONDS**, tags `DisableFocusBall`, `HudHideCross`, `SuppressEnergyRecovery`, `Active1010020`).
  - **Sub-Abilities & Homing Mechanics**:
    - `101003` (HomerMapStrikeShoot): Homing lock radius = **16.0 METERS** (`FPParam01 = 16.0`), max angular homing per frame = **2.0°** (`FPParam02 = 2.0`).
    - `101005` (HomerMapStrikeSwipeShoot / 四海游龙): Screen swipe curve shot. Min swipe distance = 3.0m, default distance = 10.0m, homing capture radius = **16.0m**, homing turn rate = 2.0°/frame.
  - **Tactical Effects (Bird's Eye Homing Passes/Throws)**: Camera shifts to full tactical overview for up to 60s. Throws and shots curve and track targets with active 16m homing attraction.
- **Small Skill (Type 2)**: `101004` — **Elastico (牛尾巴过人)**
  - **Resource Cost**: **160 Stamina** | Cooldown: None.
  - **Tactical Effects (Counter-Stun Punishment)**: Signature Elastico flick. If an opposing defender initiates a tackle while Homer is executing the move, the defender suffers a **long off-balance stun**!
- **Passives**: `3044` (Long Range Cannon +8), `3029`, `3031`, `3028`.

---

### 10. Oscar (奥斯卡) — ST (Striker)
- **Base Stats (Lvl 1)**: Power = **78**, Stamina = 78, Max Energy = **320**.
- **Ultimate Skill (Type 1)**: `101102` — **SavageDash (野性狂飙 / Savage Dash)**
  - **Resource Cost**: **320 Energy** | Cooldown: None.
  - **Buffs Applied**: Buff `1011010` (Duration: **5.30 SECONDS**), Buff `1011011` (Off-ball duration: 5.00s), Buff `1011012` (Ball speed boost duration: 4.00s).
  - **Tactical Effects (Knockback Train & Dynamic Ball Speed)**:
    - **KNOCKBACK EFFECT**: Oscar charges forward like a juggernaut for 5.3s, **knocking back every defender in his path**.
    - **BALL SPEED BOOST**: Can unleash a Savage Shot during the charge. **The longer he dashes before shooting, the higher the projectile velocity of the shot**!
- **Small Skill (Type 2)**: `101104` — **TwoPointSprint (蓄力冲撞 / Two Point Sprint)**
  - **Resource Cost**: **300 Stamina** | Cooldown: None.
  - **Tactical Effects**: Builds up power and bursts forward, **knocking back opponents in his trajectory**. Dash distance scales with charge time.
- **Passives**: `3056` (In-box Scramble +6 via Buff `30560` 0.5s), `3057` (Tight Angle Expert: shot speed boost & rapid ball dip), `3001` (Low Bullet Pass), `3046` (Superhuman Fitness: Buff `30460` grants **+10 Shot Power for 3.0s**).

---

### 11. Steffie (史黛菲) — CB (Center Back)
- **Base Stats (Lvl 1)**: Power = 75, Stamina = 76, Max Energy = **360**.
- **Ultimate Skill (Type 1)**: `101202` — **SteffieDoodleBuff (涂鸦风暴 / Doodle Storm)**
  - **Resource Cost**: **360 Energy** | Cooldown: None.
  - **Buffs Applied**:
    - Buff `1012010` (Activation trigger, 1.0s).
    - Buff `1012011` & `1012013` (Speed Boost: Duration: **3.00 SECONDS**, grants speed boost to all outfield teammates).
    - Buff `1012012` (Dual Slide Replacement: Duration: **10.00 SECONDS**, replaces teammates' tackle with Double Tackle).
  - **Tactical Effects**: Team-wide defensive buff. For 3 seconds grants all teammates an acceleration surge; for 10 seconds empowers all outfield teammates with **Dual Slide (Double Tackle)**.
- **Small Skill / DefendDown (Type 0/2)**: `101201` — **DoubleTackle (双段铲球 / Dual Slide)**
  - **Resource Cost**: **320 Stamina** (Cheaper than default 380 tackle).
  - **Tactical Effects (Zero-Penalty Chained Tackle)**: After performing a sliding tackle, Steffie springs back up immediately and can **chain directly into a second consecutive slide tackle**, completely bypassing the usual grounded tackle recovery delay.
- **Passives**: `3034` (Coordinated Defense), `3054` (Anticipate Contest), `3049` (Buff `30490` grants **+10% Movement Speed for 3.0s**), `3011` (Solid as a rock).

---

### 12. Tatsuya (达也) — WF (Wing Forward)
- **Base Stats (Lvl 1)**: Power = 59, Stamina = 78, Max Energy = **390**.
- **Ultimate Skill (Type 1)**: `101302` — **TatsuyaSuperDash (穿梭疾驰 / Super Dash Shuttle)**
  - **Resource Cost**: **390 Energy** | Cooldown: None.
  - **Tactical Effects (Flank Bonus Multi-Dash)**: Executes multiple high-speed directional dashes with instantaneous cutting angles. **When activated while positioned on the wing / flank, grants 1 additional consecutive dash**!
- **Small Skill (Type 2)**: `101304` — **Dash (冲锋 / Rush)**
  - **Resource Cost**: **0 STAMINA / 0 ENERGY (FREE COST)**!
  - **Cooldown**: **5.50 SECONDS** (`CooldownSecs = 5.5s`, `StartAfterUse`).
  - **Tactical Effects**: High-frequency zero-cost sprint burst in moving direction on a 5.5s cooldown clock.
- **Passives**: `3037` (Lightning Raid), `3013` (Limit Sprint), `3047` (Adaptability: Buff `30470` increases energy regen rate, Buff `30471` boosts shooting accuracy), `3032` (Interaction speedup Buff `30320` 3.0s).

---

### 13. Maxim (马克西姆) — GK (Goalkeeper)
- **Base Stats (Lvl 1)**: Power = **100**, Short Pass = **100**, Jockey Speed = **100**, Shot Power = 90, Stamina = 75.
- **Energy Pool & Recovery**: EnergyMaxA = 0, all actions generate 0 energy (`FootballPlayerRecoverEnergyTable`).
- **Dedicated Goalkeeper Ability Suite**:
  - `1008`: Goalkeeper Aura Buff (Active permanently).
  - `100501` — **GoalKeeperShoot**: Goal kick / clearance blast. Cost: None.
  - `100502` — **GoalKeeperTap**: Short distribution pass or underhand throw to open defenders. Cost: None.
  - `100503` — **GoalKeeperDive**: Multi-tier diving save system:
    - Angles: 45° and 67° east/west.
    - Heights: Low, Mid, High (`CatchFar`, `CatchMid`, `CatchClose`, `Punch`).
  - `100504` — **GoalKeeperTackle**: Sliding ground smother at the attacker's feet to strip the ball. Cost: None.

---

## 6. Energy Recovery Action Matrix

Extracted from `FootballPlayerRecoverEnergyTable.txt` (energy restored per successful in-game action):

| Character | Has-Ball Shoot | Loose-Ball Shoot | Has-Ball Pass | Loose-Ball Pass | Catch / Take Ball | Sliding Tackle | Standing Tackle | Shoulder Barge | Pull Ball (Drag) | Push Ball (Knock-on) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Orion (1001)** | 12 | 16 | 6 | 8 | 2 | 5 | 5 | 0 | 3 | 0 |
| **Hayato (1002)** | 8 | 12 | 10 | 12 | 2 | 10 | 10 | 0 | 3 | 0 |
| **Andrew (1003)** | 4 | 4 | 5 | 8 | 2 | **20** | **20** | **3** | 2 | 0 |
| **Kelly (1004)** | 9 | 13 | 8 | 10 | 2 | 8 | 8 | 0 | 0 | **3** |
| **Maxim (1005)** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Shirou (1006)** | 12 | 16 | 6 | 8 | 2 | 5 | 5 | 0 | 3 | 0 |
| **Rafael (1007)** | 8 | **20** | 2 | 4 | 2 | 5 | 5 | 0 | **8** | 0 |
| **Moco (1008)** | 6 | 6 | 5 | 5 | 2 | 10 | 10 | 0 | 0 | 0 |
| **Ford (1009)** | 4 | 4 | 5 | 8 | 2 | **20** | **20** | **5** | 2 | 0 |
| **Homer (1010)** | 8 | 12 | 10 | 12 | 2 | 10 | 10 | 0 | 3 | 0 |
| **Oscar (1011)** | 12 | 16 | 6 | 8 | 2 | 5 | 5 | 0 | 3 | 0 |
| **Steffie (1012)** | 4 | 4 | 5 | 8 | 2 | **15** | **20** | **6** | 2 | 0 |
| **Tatsuya (1013)** | 9 | 13 | 8 | 10 | 2 | 8 | 8 | 0 | 0 | **3** |

---

## 7. Complete Summary Comparison Table

| Character | Position | Ultimate Skill | Ult Cost | Ult Range / Special Condition | Small Skill | Small Cost & Cooldown | Key Tactical Effect |
| :--- | :---: | :--- | :---: | :--- | :--- | :---: | :--- |
| **Andrew** | CB | **Super Tackle** | 420 E | **18.0m** range; off-ball only | **Shoulder Barge** | 400 Stamina (0s CD, 2m) | **Knockdown + immediate ball control at feet**; 87 Power |
| **Ford** | CB | **Super Block** | 380 E | 4.0s duration; off-ball only | **Shoulder Barge** | 400 Stamina (0s CD, 2m) | **Absolute lane blockage + auto-clearance kick** to opp. half |
| **Orion** | ST | **Bicycle Kick** | 530 E | In possession / loose ball; swipe aim | **Orion Pull** | 320 Stamina (0s CD) | **Untackleable aerial bicycle kick** (5s ball tackle immunity) |
| **Hayato** | CM | **Super Dribble** | 320 E | **8.0m radius, 120° cone**, 2m push | **Hayato Pull** | 160 Stamina (0s CD) | **Chained dribble breaking past up to 3 defenders** |
| **Kelly** | WF | **Wall Dash** | 440 E | **15m to wall, 8m extension, 1.8m jump** | **Push Ball** | 150 Stamina (0s CD) | **Wall ride sprint bypassing ground tackles + aerial volley** |
| **Shirou** | ST | **Dual Shoot** | 390 E | Teammate link (10s aura) | **Rainbow Flick** | 175 Stamina (0s CD) | **AoE Knockdown / Hit-Fly blaster shot** clearing opponents |
| **Rafael** | ST | **Super Fake Shoot** | 460 E | 10s Super Armor, **2 fake shots** | **Cut Turn** | 250 Stamina (0s CD) | **Stuns / unbalances opponents**; unstoppable Power Shot |
| **Moco** | CM | **Hacker Mark** | 380 E | **20.0s team-wide global radar** | **One-Two Pass** | 100 Stamina (25m / 50m) | **Pitch-wide precision passing**; instant 1-2 return pass |
| **Homer** | CM | **Full Vision** | **280 E** | **60.0s overview**, **16.0m homing radius** | **Elastico** | 160 Stamina (0s CD) | **Long-range curved homing throws**; tackle counter-stun |
| **Oscar** | ST | **Savage Dash** | 320 E | **5.3s dash charge** | **Two Point Sprint** | 300 Stamina (0s CD) | **Knocks back opponents in path**; shot speed scales with dash |
| **Steffie** | CB | **Doodle Storm** | 360 E | **3s speed boost + 10s Dual Slide for team**| **Double Tackle** | 320 Stamina (0s CD) | **Chained zero-recovery consecutive slide tackles** |
| **Tatsuya** | WF | **Super Dash Shuttle**| 390 E | **+1 bonus dash on wing / flank** | **Dash** | **0 Cost (5.5s CD)** | High-frequency 0-cost directional dash bursts |
| **Maxim** | GK | **Goalkeeper Suite** | 0 E | Permanent GK Aura | **Dive / Smother** | 0 Cost | Multi-angle, multi-height diving saves & ground smother |
