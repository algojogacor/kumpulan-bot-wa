# Laporan Verifikasi Temuan Audit Flash Peak TMS (T1–T18)

**Task ID:** flash-peak-tms-verify-and-fix-audit-v1
**Tanggal verifikasi:** 21 November 2026
**Repo / commit diverifikasi:** `github.com/algojogacor/TurFpeak` master @ `03f8860` (clone fresh, read-only)
**Metode:** pembacaan ulang seluruh file:baris yang disebut laporan audit + dry-run independen (DB SQLite in-memory nyata, migrasi asli dijalankan) — `verify-artifacts/dryrun_verify_tms_audit.ts` (7 asersi) dan `verify-artifacts/dryrun_verify_tms_audit2.ts` (6 asersi). Baseline sebelum verifikasi: `tsc --noEmit` bersih, `vitest run` **248/248 PASS**.
**Status tahap:** VERIFIKASI SELESAI — belum ada satu pun perbaikan yang diterapkan (sesuai instruksi: laporkan dulu, fix menyusul per temuan).

Legenda status: **TERKONFIRMASI** (bug ada persis seperti dilaporkan), **BERBEDA DARI LAPORAN** (ada, tapi mekanisme/dampaknya tidak persis seperti ditulis), **TIDAK TERKONFIRMASI** (kode sudah benar).

---

# ADENDUM FOLLOW-UP 3 (21 Nov 2026): Fix Blocker & Quick-Wins dari Second-Opinion Review PR #8

Task: `flash-peak-tms-followup-roundcode-blocker-v1` (branch `audit/verify-fix-v1`). Second-opinion review independen PR #8 menemukan 1 blocker + 2 quick-win; ketiganya kini **FIXED** dengan bukti dry-run reproduksi skenario reviewer.

| Item | Status | Fix | Bukti |
|---|---|---|---|
| **blocker-roundcode** — label ronde dari jumlah fixture → tabrakan label ROUND_OF_16 di turnamen ≥6 grup (≥24 tim), `!startknockout` menghidupkan tim tersingkir, turnamen tak konvergen | **FIXED** | `deriveKnockoutRoundCode()` di `src/competition/fixtures.ts`: label natural by jumlah match → bila terpakai maju sepanjang progresi R32→R16→QF→SF→FINAL (selalu menyempit, tak pernah mundur) → ronde 1-match SELALU FINAL → fallback unik `KNOCKOUT_ROUND_<n>` bila progresi habis. Plus: ordering ronde di `matchday-service.ts` dari leksikalis → rank progresi + first-seen. | `check_roundcode_fix.mts`: PART 1 skenario reviewer 24 tim via `!startknockout` berturut-turut → `ROUND_OF_32 → ROUND_OF_16 → QUARTER_FINAL → FINAL`, label unik, **TIDAK ADA tim tersingkir hidup lagi**, konvergen. PART 2/2b regression: ukuran Gojiha (16 tim) & 16 kualifikasi → label **identik perilaku lama**. PART 3: fallback unik tanpa kolisi. +2 test permanen (`tests/unit/competition.test.ts`). |
| **quickwin-shuffle-validation** — validasi shuffle curang berbasis identitas objek bisa dilewati mutasi `team_id` (self-match X vs X lolos) | **FIXED** | Validasi kini berbasis multiset `team_id`: hasil draw harus memuat PERSIS team_id pool asli (sorted compare); tambah/kurang/gandakan/mutasi ditolak. | `check_quickwins_fix.mts` PART A: serangan persis reviewer (mutasi team_id antar objek baru) **DITOLAK**; duplikat/elemen-hilang tetap ditolak; shuffle sah (reverse, same-ref) tetap diterima tanpa self-match. +1 test permanen. |
| **quickwin-group-null-message** — pesan `!matchday`/reminder menampilkan "(Grup null)" untuk fixture knockout & selalu menyebut D-031 | **FIXED** | Label per-stage: knockout → `(Knockout)`, grup tetap `(Grup X)`; regulasi per-stage: D-031 hanya bila ada fixture grup pending, D-032 (kalah ganda + bye) bila ada fixture knockout pending. | `check_quickwins_fix.mts` PART B: B1 ronde KO → "(Knockout)" + D-032, tanpa "(Grup null)"/D-031; B2 regression ronde grup → "(Grup A)" + D-031 persis wording lama. |

**Regression gate setelah semua fix:** `tsc --noEmit` clean; `vitest run` **253/253 PASS**; seluruh 24 check script + 2 dry-run audit lama exit 0 (T2-FIX, BRACKET-REDRAW, T17-FIX, dst. tetap VERIFIED); ESLint 7 warning pre-existing / 0 error (identik baseline via stash).

**Catatan konteks (dari Arya):** untuk turnamen ukuran Gojiha (16 tim, QF→SF→Final) blocker ini memang tidak pernah relevan karena jumlah fixture tiap ronde selalu unik — tetap difix supaya codebase aman untuk turnamen besar (≥24 tim) di masa depan. Detail lengkap: lihat `worklog.md` sesi "Follow-up 3".

---

## Batch 1 (High)

### T1 — Deteksi duplikat KO berbasis pasangan skor salah tandai game sah sebagai duplikat — **TERKONFIRMASI**

- **Bukti kode:** `src/application/ko-evidence-pipeline.ts:345-393` (Guard 3). Setiap foto baru dibandingkan terhadap SEMUA game yang sudah diputuskan; jika pasangan skor identik (`samePair`, baris 369), foto langsung dianggap duplikat game lama dan **tidak pernah diterapkan sebagai game baru**.
- **Bukti dry-run:** BO3, game 1 tercatat 2-0 (`GAME_APPLIED`), lalu game 2 yang sah juga berakhir 2-0 → outcome `DUPLICATE`, skor series tetap 1-0 (seharusnya 2-0 = series selesai).
- **Dampak nyata:** skor seri pasangan sangat umum (mis. 2-0 dan 2-0, atau 1-0 dan 1-0 pada game berbeda). Series bisa **tidak pernah selesai** lewat jalur foto; delegasi harus minta panitia `!kores` padahal fotonya sah. Ini juga jalan pintas ke T2 (series menggantung → tidak bisa lanjut ronde).
- **Catatan mekanisme:** guard 2 (slot sama, baris 305-343) sudah benar; masalahnya khusus guard 3 yang membandingkan lintas slot. Komentar kode (baris 365-368) mengklaim mirror "bukan duplikat", tapi kasus *pasangan identik di slot berbeda* memang game sah yang berbeda — asumsi guard 3 salah fundamental karena skor pasangan bukan identitas game.

### T2 — Survivor ganjil pasca bye membuat bracket deadlock — **TERKONFIRMASI**

- **Bukti kode:** `src/competition/fixtures.ts:308-310` melempar `Jumlah juara grup (rank 1) harus sama dengan runner-up grup (rank 2)` bila `winners.length !== runnersUp.length`. Di `src/application/tournament-commands.ts:3025-3047`, `!startknockout` membangun `nextQualifiers` dengan `half = floor(winners.length / 2)`; jumlah survivor **ganjil** (mis. 3 semifinalis karena satu semi double-loss + bye) menghasilkan rank `[1,2,2]` → winners=1, runnersUp=2 → throw.
- **Bukti dry-run:** `generateKnockoutFixtures` dengan 3 qualifier (rank 1,2,2) → throw pesan persis di atas.
- **Dampak nyata:** skenario D-032 (double loss → bye pasangan) yang justru fitur yang didukung kode (`tournament-commands.ts:2920-2937`) dapat menghasilkan jumlah survivor ganjil; `!startknockout` selanjutnya selalu gagal → turnamen macet permanen sampai intervensi DB manual.
- **Catatan:** bye di `!startknockout` hanya dipicu pasangan double-loss; jalur bye ini memang bisa menghasilkan 3 survivor dari 4 semifinalis (1 semi double-loss → 1 pemenang semi satunya dapat bye, + 2 pemenang semi lain = 3). Laporan audit akurat.

### T3 — `!approve` organizer ditolak kalau konfigurasi cuma `WA_ORGANIZER_PHONE` — **TERKONFIRMASI**

- **Bukti kode:** `src/application/tournament-commands.ts:602` memakai `approverId = ctx.delegateId || ctx.message.sender_normalized_address` → bentuknya `628xxx@s.whatsapp.net`. `src/index.ts:1050-1066` meneruskan `allowed_organizer_ids: this.commandRouter.getOrganizerIdentities()`. `src/whatsapp/router.ts:61-75` hanya mengembalikan **digit telepon** (`6281234567890`) untuk kasus WA_ORGANIZER_PHONE (JID kosong). `src/reports/approval.ts:94-105`: karena `hasConfiguredIds === true`, cabang `isOrganizerExplicit` tidak berlaku → `628xxx@s.whatsapp.net` tidak ada dalam set `{ORGANIZER, 6281234567890}` → **REJECTED**.
- **Bukti dry-run:** `isSenderOrganizer=true` (role ORGANIZER lolos), `getOrganizerIdentities()=['6281234567890']`, approverId `6281234567890@s.whatsapp.net` → tidak diizinkan.
- **Dampak nyata:** deployment yang hanya set `WA_ORGANIZER_PHONE` (bentuk yang justru ditampilkan `.env.example:28`) → organizer bisa menjalankan semua command lain, tapi **suara approval ORGANIZER selalu ditolak** → laporan grup tidak pernah LOCK (butuh 3 pihak). Kondisi `dry-run 1 bag. 7` reproduksi.
- **Akar masalah:** mismatch format — `isSenderOrganizer` (router) cocokkan digit, sedangkan `verifyApproverAuthority` (approval) cocokkan string penuh terhadap daftar yang tidak memuat varian JID dari phone.

### T4 — Foto polos tanpa caption `!kogame` bocor ke pipeline BO1 saat fase knockout — **TERKONFIRMASI**

- **Bukti kode (trace penuh):** `src/index.ts:620-699` — foto tanpa caption tidak diintersepsi jalur `!kogame` (baris 273 hanya match caption berawalan `!kogame`), jatuh ke jalur evidence generik → `resolveFixtureForMessage` (`src/application/fixture-resolver.ts:25-175`) yang query fixture **tanpa filter `stage`** (baris 60-68, 129-141, 153-164: hanya `status IN ('SCHEDULED','IN_PROGRESS')`) → fixture knockout aktif bisa terpilih → `findOrCreateReportSession` + debounce → `processClaimedBatch` (`evidence-batch-processor.ts`) membuat draf BO1 untuk series BO3/BO5.
- **Mitigasi yang sudah ada (dipakai sebagai bukti ada jalur bolong):** `evidence-batch-processor.ts:286-307` tahu fixture itu knockout (`isKnockoutSeries`), tapi hanya memakainya untuk **kuota screenshot kiper** — draft tetap dibuat (`createReportDraft`, baris 438) dengan status PENDING_APPROVAL/NEEDS_CORRECTION. Jika sampai LOCK, `onReportLocked` (`stats.ts:190-226`) menandai fixture COMPLETED hanya dari game yang tidak selesai — bisa melengkapi/mengacak state series yang seharusnya dikelola `applyKoGameEvidence`.
- **Dampak nyata:** peserta yang lupa caption (perilaku yang sangat umum) membuat draf laporan BO1 paralel untuk series knockout → dua sumber kebenaran, kebingungan approval 3 pihak, dan potensi series "selesai" via jalur yang salah.
- **Catatan:** jalur fallback `getPending`/resolver memang mendahulukan fixture grup, tapi saat semua fixture grup sudah COMPLETED (fase knockout murni), fallback #3 (`fixture-resolver.ts:153-164`) memilih fixture pertama tournament aktif tanpa melihat stage — inilah titik bocor pasti.

## Batch 2 (Medium)

### T5 — `!kores` tidak bisa koreksi series yang sudah COMPLETED — **TERKONFIRMASI**

- **Bukti kode:** `src/competition/series.ts:134-136` — `recordSeriesGameResult` melempar `Series ini sudah selesai. Tidak dapat menambah atau memperbarui game.` saat `series.status === 'COMPLETED'`. `src/application/tournament-commands.ts:3361-3363` berkomentar "Organizer correction on a COMPLETED series is allowed … via recordSeriesGameResult's decrement logic" — **komentar itu salah**, decrement logic (series.ts:254-266) tidak pernah tercapai karena guard COMPLETED lebih dulu.
- **Bukti dry-run:** series BO3 diselesaikan 2-0 (game 2 `is_series_complete=true`), lalu `!kores <fixture> 2 1-3` → throw persis pesan di atas; handler membalas "⚠️ Gagal mencatat hasil game knockout: Series ini sudah selesai…".
- **Dampak nyata:** dokumentasi `cara-penggunaan.md:537` menjanjikan "Kalau series sudah selesai, hasil game yang sama bisa di-rekam ulang lewat perintah yang sama dan series akan dihitung ulang" — **janji itu tidak dipenuhi kode**. Organizer tidak punya cara apa pun (termasuk `!reopen`, yang hanya untuk report version grup) untuk mengoreksi hasil knockout yang salah.

### T6 — Koreksi natural-language organizer ditolak 'Unauthorized sender' — **TERKONFIRMASI**

- **Bukti kode:** `src/application/report-correction-coordinator.ts:89-121` — `senderId = resolved?.delegate?.id || message.sender_normalized_address` (baris 90), lalu `applyReportCorrection` dipanggil **tanpa `is_organizer`** (baris 116-121). `src/reports/corrections.ts:55-96` — organizer diizinkan hanya via `isOrganizerExplicit || senderId === 'ORGANIZER'`; keduanya tidak terpenuhi untuk organizer yang bukan delegasi tim manapun → `UNAUTHORIZED` (baris 144-172).
- **Bukti dry-run:** koreksi dari `6289977777777@s.whatsapp.net` (organizer, bukan delegasi) → `REJECTED: "Unauthorized sender: only Team A delegate, Team B delegate, or Organizer can submit corrections."`.
- **Dampak nyata:** satu-satunya jalur koreksi NL organizer mati; hanya delegasi tim A/B yang bisa. `handleCorrection` di `src/index.ts:1026-1045` juga tidak punya akses ke info organizer (tidak menerima/mengecek `isSenderOrganizer`) — perlu diteruskan dari `handleInboundMessage` (yang punya `this.commandRouter`).

### T7 — Race condition saat dua foto KO tiba bersamaan — **BERBEDA DARI LAPORAN (lebih sempit)**

- **Bukti kode:** `src/cli/start.ts:267-329` — handler `messages.upsert` memproses pesan **berurutan** (`for … await`), jadi dua foto dalam satu event upsert di-serialize. Tidak ada worker paralel untuk jalur KO: `applyKoGameEvidence` hanya dipanggil dari `handleInboundMessage`.
- **Sisa celah nyata:** (a) dua event `messages.upsert` terpisah dapat berjalan interleave di titik `await` (JavaScript single-thread tapi async interleaving antar handler tetap mungkin — dua promise handler aktif bersamaan); (b) `applyKoGameEvidence` membaca konteks series (`getKoSeriesContext`, `deriveOpenGameSlot`) DI LUAR transaksi (`ko-evidence-pipeline.ts:248-303`), transaksi `write` baru dibuka di baris 407. Tanpa `BEGIN IMMEDIATE` / cek versi, dua foto yang interleaving bisa derive slot sama (game 1) dua kali → `recordSeriesGameResult` upsert game_number 1 dua kali → skor series dihitung ganda/salah.
- **Kesimpulan:** race-nya **mungkin** tapi butuh timing antar-event upsert terpisah (bukan "dua foto dalam satu batch" seperti tersirat dry-run 3 bag. E). Severity lebih rendah dari laporan (Low–Medium, bukan Medium-High), namun read-then-write tanpa lock memang pola yang harus diberi transaksi penuh. **Perlu fix, desain fix T1 akan merangkulnya** (pindahkan derive slot ke dalam transaksi).

### T8 — Konfirmasi draft manual report bisa dipicu 'ok' dari sembarang anggota grup — **TERKONFIRMASI**

- **Bukti kode:** `src/index.ts:514-557` — blok 1.5 `hasPending(chat_id, sender_normalized_address)` → teks `ok`/`ya`/`confirm`/`lanjut`/`benar`/`sudah benar` langsung memanggil `confirmPending` **tanpa cek role organizer**. `manual-report-session.ts:77-89` `getPending` fallback ke key `chatId` saja (baris 79: `|| this.pendingSessions.get(chatId.toLowerCase())`) — session yang di-stage organizer di grup bisa di-claim siapa pun yang mengetik 'ok' di grup itu. `confirmPending` (baris 366-380) memanggil `handleManualReport` dengan `is_organizer: true` **hardcoded** — siapa pun pemancingnya, draf dibuat atas nama organizer.
- **Dampak nyata:** anggota grup biasa bisa "menembakkan" draft laporan manual yang sudah di-stage (mengunci pilihan skor pencetak gol hasil tebakan bot) sebelum organizer sempat mengoreksi. Jalur command `!ok`/`!confirm` (tournament-commands.ts:1630+) AMAN (requiredRole ORGANIZER) — celahnya hanya jalur plain-text di index.ts.
- **Catatan:** koreksi (`isCorrection`, baris 533-556) juga tidak dicek role-nya — siapa pun bisa mengubah daftar pencetak gol yang di-stage. Sama-sama bagian dari temuan ini.

## Batch 3 (Low / Phantom / Sebagian)

### T9 — Mode teks `!kogame <fixture_id>` phantom — **TERKONFIRMASI (sebagai shadowing, bukan phantom total)**

- **Bukti kode:** `src/index.ts:273-284` — SEMUA pesan berawalan `!kogame` diintersepsi lebih dulu oleh `handleKoGameEvidenceMessage`. Tanpa foto → balasan canned "📸 Kirim screenshot… teks saja tidak bisa diproses" (`index.ts:728-732`) dan **tidak pernah jatuh** ke handler `kogame` ter-registrasi di router (`tournament-commands.ts:3222-3280`) yang justru mengimplementasikan status lookup `!kogame <fixture_id>` (series progress, slot menunggu, pemenang).
- **Dampak nyata:** fitur "Cek status series kapan saja (tanpa foto): `!kogame fix-ko-1`" yang DIIKLANKAN `cara-penggunaan.md:506-510` **tidak pernah bisa dipakai** — user selalu dapat balasan "kirim sebagai foto". Dead code + janji dokumen yang bohong.
- **Koreksi kecil terhadap laporan:** handler text-mode-nya ADA dan ter-register (bukan phantom wiring); yang rusak adalah urutan intersepsi. Fix = biarkan pesan TEKS (tanpa media) jatuh ke router.

### T10 — Delegasi tim tanpa delegate dapat direbut via `!roster` — **TERKONFIRMASI**

- **Bukti kode:** `src/application/tournament-commands.ts:2077-2114` — bila tim sudah ada (didapat via nama di pesan) tapi `delegate_id` NULL, handler **otomatis membuat delegate dari alamat pengirim** dan `bindDelegateToTeam` menimpa `teams.delegate_id` tanpa gate organizer. `resolver.ts:338-351` — `bindDelegateToTeam` juga men-set `registration_status='VERIFIED'` tanpa syarat.
- **Bukti dry-run:** tim PENDING tanpa delegate → delegate baru dari pengirim arbitrer ter-bind langsung.
- **Dampak nyata:** tim yang didaftarkan panitia via `!addteam` (belum onboarding) bisa "dikuasai" orang pertama yang mengetik `!roster <nama tim> …` di grup — dia menjadi delegasi resmi + tim jadi VERIFIED. Guard otorisasi (baris 2111-2116) hanya aktif SETELAH auto-bind, jadi tidak menahan kasus delegate NULL.
- **Catatan desain:** auto-bind jelas fitur onboarding yang disengaja (self-registration via roster), jadi fix-nya perlu kebijakan: mis. izinkan hanya saat status turnamen REGISTRATION/ONBOARDING, atau wajib konfirmasi organizer untuk tim yang dibuat panitia. Keputusan: saya akan menandai sebagai PENDING-DESIGN (dilaporkan, tidak difix blind) — lihat rencana perbaikan.

### T11 — Status `NEEDS_REVIEW` tidak pernah di-set — **TERKONFIRMASI**

- **Bukti kode:** grep seluruh `src/` — `NEEDS_REVIEW` hanya muncul sebagai: definisi union type (`ko-evidence-pipeline.ts:56,177`), komentar (baris 22, `tournament-commands.ts:3287`), dan branch render di `index.ts:968`. **Tidak ada satu pun `journalEvidence(..., 'NEEDS_REVIEW', ...)`**.
- **Bukti dry-run:** game 1 tercatat 2-0; foto konflik 0-2 (skor beda untuk game yang sudah diputuskan) → TIDAK jadi NEEDS_REVIEW, melainkan diterapkan sebagai game 2 (`GAME_APPLIED`, journal `2:APPLIED`). Guard 3 menangani mirror sebagai "game baru normal" (komentar baris 365-368), jadi jalur konflik sesungguhnya tak terjangkau oleh foto — komentar header pipeline (baris 21-23: "journaled NEEDS_REVIEW and never auto-applied") **menjanjikan perilaku yang tidak ada**.
- **Dampak nyata:** janji dokumen (`cara-penggunaan.md:528` "sistem menandainya butuh review") tidak terpenuhi; foto konflik diam-diam jadi game berikutnya (ini beririsan T1 — fix T1 harus mendefinisikan ulang semantik konflik vs game baru).
- **Koreksi kecil:** bukan sekadar "tidak pernah di-set" — kondisi yang seharusnya memicunya (foto beda skor untuk slot decided) **tidak dapat terjadi** karena derive slot selalu pindah ke slot terbuka. Perilaku salahnya lebih fundamental: konflik tak terdeteksi.

### T12 — Pola otorisasi lemah di `manual.ts` — **TERKONFIRMASI**

- **Bukti kode:** `src/reports/manual.ts:58-65` — `isOrganizerAuthorized` masih menerima `organizerId.startsWith('org_')` dan `organizerId.toLowerCase().includes('organizer')`. FIX2-APR-003 menghapus pola yang sama dari `approval.ts` tapi tidak dari sini.
- **Bukti dry-run:** `handleManualReport` dengan `organizer_id: 'org_legit'` dan `'i-am-the-organizer-trust-me'` lolos gate (error berikutnya adalah fixture-not-found, bukan Unauthorized).
- **Dampak nyata:** terbatas — semua caller produksi (`confirmPending` pakai `is_organizer: true` hardcoded; command handler juga set `is_organizer: true`) sehingga jalur string-pattern ini belum ter-eksploitasi via WhatsApp; tapi ini tetap pintu belakang API untuk caller non-produksi/admin-tool, dan inkonsisten dengan kebijakan FIX2-APR-003. Low severity, fix murah (satu fungsi).

### T13 — Intent NL tanpa scope-check grup — **TERKONFIRMASI**

- **Bukti kode:** `src/index.ts:288-512` — intent NL (klaim WO, jadwal, aturan, topskor, klasemen, roster) dijawab **tanpa memeriksa `chat_id === centralGroupJid`**; pemeriksaan scope FR-ID-005 hanya ada di `CommandRouter.handleMessage` (`router.ts:262-295`) untuk command ter-registrasi. Foto bukti (jalur #4) juga tanpa cek grup.
- **Dampak nyata:** bot merespons query turnamen (dan menerima foto bukti/WO claim) di grup lain/DM; WO claim di grup lain tetap menghasilkan prompt ke organizer (staging in-memory per chat), dan foto bukti dari grup asing tetap masuk pipeline debounce. Ingin saya coret sebagai "hanya informational reply" — tapi jalur WO-claim + bukti punya efek state, jadi ini bukan sekadar kebocoran informasi.
- **Catatan:** severity rendah untuk turnamen satu-grup, tapi melanggar FR-ID-005 secara struktural. Fix natural: satu gate `isCentralGroup` di awal `handleInboundMessage` untuk semua jalur non-command (DM organizer tetap dikecualikan).

### T14 — `resolveIdentity` memilih team tanpa filter turnamen — **TERKONFIRMASI**

- **Bukti kode:** `src/identity/resolver.ts:164-188` — query `teams WHERE delegate_id = ? LIMIT 1` **tanpa `tournament_id`**. Sistem multi-turnamen (data lama masih ada di DB saat turnamen baru dibuat — `!createtournament` tidak menghapus tim lama) → delegasi lama teresolve ke tim turnamen lama.
- **Dampak nyata:** `resolveIdentity(rawAddress)` versi 1-arg (dipakai `report-correction-coordinator.ts:89`, jalur bukti `index.ts:622`) bisa mengembalikan tim yang bukan milik turnamen aktif → fixture resolver / koreksi salah sasaran. Versi 2-arg (dengan chat_id) juga tidak memfilter turnamen (chat_id hanya dipakai untuk pencatatan source). Pada deployment 1 turnamen aktif dampaknya tersembunyi, tapi `!createtournament` memang bisa dijalankan ulang (turnamen baru, tim lama tetap di DB) — bug laten nyata.
- **Catatan:** fix perlu definisi "turnamen aktif" (status ACTIVE) dan fallback bila delegasi punya tim di >1 turnamen.

### T15 — Kualifikasi KO mengabaikan tie-breaker head-to-head — **TERKONFIRMASI**

- **Bukti kode:** `src/competition/fixtures.ts:470-499` (`deriveKnockoutQualifiers`) — SQL `ORDER BY points DESC, goal_difference DESC, goals_for DESC` **tanpa H2H**; `standings.ts:222-263` (`computeGroupStandings`) memecah seri Poin/GD/GF dengan H2H. Dua mesin urutan berbeda untuk data yang sama.
- **Bukti dry-run:** grup 3 tim, Bravo & Charlie seri penuh Pts/GD/GF, Bravo menang H2H → `computeGroupStandings` (dipakai `!standings`): Alpha > **Bravo** > Charlie. `deriveKnockoutQualifiers` (dipakai `!startknockout`): SQL tidak punya kolom H2H — urutan rank 2/3 ditentukan arbiträr oleh engine DB (dan guard `firstKey === secondKey` baris 488-497 malah melempar error "masih seri penuh" untuk kasus rank 1-2 yang sebenarnya sudah bisa dipecahkan H2H).
- **Dampak nyata:** klasemen yang ditampilkan bisa **berbeda** dari tim yang lolos knockout; atau `!startknockout` menolak jalan dengan "seri penuh" padahal H2H sudah menentukan. Ini inkonsistensi keadilan kompetisi yang nyata.

### T16 — `!manualreport` tanpa guard stage knockout — **TERKONFIRMASI**

- **Bukti kode:** `src/reports/manual.ts:85-114` — tidak ada pemeriksaan `stage`; fixture KNOCKOUT diterima apa adanya (game pertama diambil dari `games` fixture itu).
- **Bukti dry-run:** fixture KNOCKOUT (series BO3) + `handleManualReport` skor 2-1 → **success=true**, report version BO1 PENDING_APPROVAL tercipta untuk series BO3.
- **Dampak nyata:** organizer yang salah memakai `!manualreport` untuk pertandingan knockout membuat draf BO1 paralel (sama seperti T4 tapi via tangan organizer). Fix: tolak dengan pesan arahkan ke `!kores`.

### T17 — Cutoff 19:59 WIB no-op pada ronde knockout — **TERKONFIRMASI (mekanisme: silent drop, bukan crash)**

- **Bukti kode:** `src/application/matchday-service.ts:215` — `getRoundFixturesWithDelegates` memakai `JOIN groups g ON f.group_id = g.id` (INNER JOIN). Fixture KNOCKOUT punya `group_id NULL` → **tidak pernah muncul** di hasil. `processDailyCutoff` (baris 267-330) lalu mencatat audit `MATCHDAY_CUTOFF` "selesai" dengan 0 fixture.
- **Bukti dry-run:** fixture SEMI_FINAL ada, query ber-JOIN mengembalikan 0 baris.
- **Dampak nyata:** deadline 19:59 tidak pernah menyerang pertandingan knockout — klaim D-031 "wajib reschedule" di knockout tidak punya enforcement apa pun; matchday baru diumumkan sementara series knockout menggantung tanpa batas. (Sisi baiknya: `handleGroupDoubleWalkover` tidak pernah dipanggil untuk KO — kalau JOIN-nya sampai bocor, dia melempar error stage, jadi desain saat ini "aman dengan diam-diam".) Laporan audit akurat pada intinya (no-op), hanya perlu dicatat bahwa ini silent-drop, bukan error.

### T18 — Alias typo `!mulainokout` — **TERKONFIRMASI (kosmetik)**

- **Bukti kode:** `src/application/tournament-commands.ts:3207-3214` — command ter-registrasi bernama `mulainokout` (maksudnya jelas `mulai knockout` → `!mulainokout` seharusnya `!mulainokout`… ejaan yang benar untuk alias ini adalah `mulainokout` ↔ `mulaiKnockout`; "nokout" kehilangan 'k' setelah 'no'). Fungsi duplikat `!startknockout`, tidak dirujuk dokumen mana pun.
- **Dampak nyata:** minimal — alias salah ketik yang aktif; user yang mengetik `!mulainokout` (dengan k) dapat UNKNOWN_COMMAND. Perbaikan: hapus alias atau tambahkan ejaan benar. Tidak menunggu keputusan desain; fix kosmetik.

---

## Ringkasan status

| Temuan | Status | Severity aktual | Fix sekarang? |
|---|---|---|---|
| T1 duplikat KO pair-score | TERKONFIRMASI | High | Ya |
| T2 survivor ganjil deadlock | TERKONFIRMASI | High | Ya |
| T3 !approve phone-only | TERKONFIRMASI | High | Ya |
| T4 foto polos bocor BO1 | TERKONFIRMASI | High | Ya |
| T5 !kores COMPLETED | TERKONFIRMASI | Medium | Ya |
| T6 koreksi NL organizer | TERKONFIRMASI | Medium | Ya |
| T7 race dua foto KO | BERBEDA (interleave antar-event, bukan batch) | Low–Medium | Ya (rangkul oleh fix T1) |
| T8 konfirmasi 'ok' siapa pun | TERKONFIRMASI | Medium | Ya |
| T9 !kogame teks tershadow | TERKONFIRMASI | Medium | Ya |
| T10 roster seize | TERKONFIRMASI | Medium | Ditunda — butuh keputusan kebijakan onboarding (dilaporkan ke Arya) |
| T11 NEEDS_REVIEW dead | TERKONFIRMASI (lebih fundamental: konflik tak terdeteksi) | Medium | Ya (bersama T1) |
| T12 manual.ts pattern | TERKONFIRMASI | Low | Ya |
| T13 NL tanpa scope grup | TERKONFIRMASI | Low–Medium | Ya |
| T14 resolver tanpa filter turnamen | TERKONFIRMASI | Medium (laten) | Ya |
| T15 H2H kualifikasi | TERKONFIRMASI | Medium | Ya |
| T16 manualreport KO | TERKONFIRMASI | Low–Medium | Ya |
| T17 cutoff no-op KO | TERKONFIRMASI (silent drop) | Low–Medium | Ditunda — kebijakan deadline knockout perlu keputusan Arya (D-031 vs D-032) |
| T18 alias typo | TERKONFIRMASI | Kosmetik | Ya |

**Tidak ditemukan temuan laporan yang TIDAK TERKONFIRMASI.** Dua temuan (T7, T17) terkonfirmasi dengan koreksi mekanisme; dua temuan (T10, T17) saya sarankan menunggu keputusan kebijakan organizer sebelum difix.

## Bug baru di luar daftar (REPORTED, belum disentuh — sesuai prinsip kerja)

1. **`bindDelegateToTeam` men-set `registration_status='VERIFIED'` tanpa syarat** (`resolver.ts:346`) — auto-verify tim yang belum onboarding; terkait T10 tapi dampaknya lebih luas (dipakai juga jalur lain).
2. **`report-correction-coordinator.ts:89` memanggil `resolveIdentity` versi 1-arg** yang mengabaikan alias per-chat — delegasi dengan beberapa alias bisa gagal resolve di jalur koreksi meski verified di jalur command (inkonsistensi dengan `router.ts:204` yang memakai 2-arg).
3. **`startKnockoutHandler` pairing bye salah pasangan** (`tournament-commands.ts:2923-2924`): partner dihitung dari **index array** (`fixtureIndex % 2`), padahal pasangan bracket tidak dijamin bersebelahan secara index setelah `ORDER BY created_at` — bye bisa diberikan ke tim yang bukan pasangan double-loss. Perlu verifikasi lanjutan sebelum fix (dilaporkan dulu).

---

*Artifact verifikasi: `verify-artifacts/dryrun_verify_tms_audit.ts` + `verify-artifacts/dryrun_verify_tms_audit2.ts` (clone ini). Semua asersi PASS = temuan audit ter-reproduksi di master @03f8860.*
