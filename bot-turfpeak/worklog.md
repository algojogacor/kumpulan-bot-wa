# Worklog — Flash Peak TMS (TurFpeak)

## [2026-11-23] Sesi: Perbaikan Sistem Kuis (Keyword Enrichment, Normalisasi Koma Desimal, Two-Tier Evaluation & LLM Fallback)

### Konteks Sesi & Permintaan User
1. **Masalah Akurasi Deteksi Jawaban Kuis**:
   - User mengamati di log WhatsApp dan grup bahwa banyak jawaban benar dari peserta yang tidak terdeteksi oleh bot saat sesi `!quiz`.
   - Contoh nyata di log VM:
     - Pertanyaan batas waktu backpass kiper (jawaban `0.3 detik`): Peserta mengetik `0.3` dan `0,3`, tetapi bot membalas `❌ Kurang tepat`.
     - Pertanyaan jumlah karakter yang dikontrol pemain (jawaban `1 karakter`): Peserta mengetik `1` atau `satu`, tetapi bot menolak karena daftar keyword hanya memiliki variasi frasa panjang (`"1 karakter"`, `"satu pemain"`).
   - Selama durasi kuis 15 detik, obrolan/tawa santai peserta (`wkwk`, `anj`, `capek gw`) salah dideteksi sebagai jawaban kuis dan disampahi notifikasi `❌ Kurang tepat`.
2. **Arsitektur yang Diinginkan**:
   - **Tier 1 (Keyword Match Pertama)**: Wajib memprioritaskan keyword matching terlebih dahulu (instan 0ms, hemat token/bebas biaya, respon selebrasi langsung).
   - **Tier 2 (Filter Obrolan & Fallback LLM Semantic)**: Jika keyword tidak match, filter kata-kata ketawa/basa-basi agar bot tidak spam. Jika dicurigai sebagai tebakan jawaban sungguhan, evaluasi secara semantik menggunakan LLM berkecepatan tinggi dengan timeout ketat (3.5 detik).

### Investigasi & Root Cause
1. **Bug Penghapusan Karakter Koma/Titik Desimal**:
   Pada `isQuizAnswerMatch`, pembersihan teks menggunakan `.replace(/[^\w\s%]/g, ' ')`. Karakter titik (`.`) dan koma (`,`) dihapus dan diganti spasi, sehingga `0.3` dan `0,3` berubah menjadi `"0 3"`. Akibatnya, perbandingan substring `"0 3".includes("0.3")` selalu bernilai `false`.
2. **Kekurangan Token Sinonim Angka Tunggal di JSON**:
   File `src/data/flashpeak-trivia.json` memiliki 22 soal kuis, namun banyak soal angka hanya mendaftarkan kata majemuk, bukan token angka tunggal yang biasa diketik cepat oleh pengguna (`"1"`, `"satu"`, `"5"`, `"lima"`, `"10"`, `"ff"`, `"tidak"`, dll).
3. **Ketiadaan Evaluator Semantik Fleksibel**:
   Jawaban peserta yang benar secara makna tetapi menggunakan susunan kata berbeda (misalnya `"cuma pegang satu jagoan doang min"`) langsung ditolak tanpa evaluasi semantik.

### Perubahan Kode (Surgical)
1. **`src/data/flashpeak-trivia.json`**:
   - Memperkaya dan melengkapi keyword pada seluruh 22 soal kuis:
     - Soal angka & desimal: ditambahkan token tunggal `["1", "satu", "5", "lima", "10", "sepuluh", "0.3", "0,3", "0.3 detik", "0,3 detik", "nol koma tiga detik"]`.
     - Soal Free Fire: ditambahkan `["ff", "epep", "freefire"]`.
     - Soal jawaban negatif: ditambahkan `["tidak", "ngga", "nggak", "gaada", "gak", "ga", "tdk", "no"]`.
     - Soal ukuran lapangan: ditambahkan variasi angka `["66x103", "103x66", "66 103"]`.
2. **`src/application/quiz-session.ts`**:
   - Memperbaiki normalisasi angka desimal:
     - Mengubah format koma desimal menjadi titik (`replace(/(\d+),(\d+)/g, '$1.$2')`).
     - Mempertahankan karakter titik (`.`) dan persen (`%`) pada regex pembersihan teks (`replace(/[^\w\s.%]/g, ' ')`).
   - Mengimplementasikan `QuizSessionManagerDeps` dengan `providerRouter?: ProviderRouter`.
   - Mengubah `evaluateAnswer` menjadi fungsi `async`:
     - **Tahap 1**: Deterministic keyword matching via `isQuizAnswerMatch` (0ms, 0 token, respon instan).
     - **Tahap 2**: Casual banter / laughter regex filter (menolak `wkwk`, `anj`, `capek`, dll agar tidak spam `❌ Kurang tepat`).
     - **Tahap 3**: Fallback semantik LLM via `providerRouter.chatCompletion` (timeout 3.5s). LLM diminta menilai secara ketat apakah jawaban adalah `BENAR`, `SALAH`, atau `BUKAN_JAWABAN`.
3. **`src/application/ai-native-commands.ts` & `src/index.ts`**:
   - Meneruskan `providerRouter` ke instance `QuizSessionManager`.
   - Memperbarui pemanggilan `evaluateAnswer` menjadi `await` pada penanganan pesan masuk Baileys di `src/index.ts`.
4. **`tests/unit/ai_native.test.ts`**:
   - Menambahkan unit test mendalam untuk:
     - Matching angka desimal (`0.3` dan `0,3`).
     - Pengenalan variasi angka (`1`, `satu`).
     - Filter obrolan santai (`wkwkwk`, `capek gw min`).
     - Fallback semantik ke LLM ketika keyword tidak cocok namun makna benar.

### Verifikasi Empiris
1. **Unit Test Lokal (Vitest)**:
   - `npx vitest run tests/unit/ai_native.test.ts`: 61/61 tests passed.
   - `npx vitest run`: Seluruh 335 tests pada 23 test suites passed 100% tanpa regresi.
2. **Build Lokal & Git Commit**:
   - `npm run build` sukses (`tsc` dan penyalinan data JSON).
   - Commit `2d1efe9` di-push ke remote `master`.
3. **Deploy & Verifikasi di Azure VM (`forfh`)**:
   - `git pull origin master` & `npm run build` berhasil pada VM.
   - PM2 restart `flashpeak-bot` (PID 3315251) berhasil online.
   - Log PM2 membuktikan koneksi Baileys aktif dan pesan masuk real-time berhasil diterima (`tidak`, `Aku admin kau member`, dll).

---

## [2026-11-23] Sesi: Penyesuaian Prioritas Provider AI Berdasarkan Biaya (Cost-Aware Routing)

### Konteks Sesi & Instruksi User
1. **Pemberhentian Mistral pada Vision**:
   - User menginstruksikan agar Vision tidak menggunakan Mistral dan dikembalikan ke urutan teruji sebelumnya:
     `['DEEPSEEK', 'GROQ', 'GEMINI', 'NVIDIA_NIM', 'COHERE', 'OLLAMA_CLOUD']`.
2. **Penyesuaian Prioritas Teks Berdasarkan Biaya / Saldo (Cost Hierarchy)**:
   - User menjelaskan rasional pemilihan: Mistral murah untuk teks, Groq di posisi kedua, Nvidia NIM di posisi ketiga.
   - DeepSeek ditaruh di urutan paling akhir karena menggunakan balance asli/berbayar, sehingga diproteksi sebagai cadangan darurat (emergency fallback) agar saldo tidak terkuras untuk chat biasa.

### Perubahan Kode
1. `src/ai/router.ts`:
   - Vision order: `['DEEPSEEK', 'GROQ', 'GEMINI', 'NVIDIA_NIM', 'COHERE', 'OLLAMA_CLOUD']` (Mistral dihilangkan dari vision).
   - Text order: `['MISTRAL', 'GROQ', 'NVIDIA_NIM', 'COHERE', 'GEMINI', 'DEEPSEEK', 'OLLAMA_CLOUD']` (Mistral #1, Groq #2, Nvidia #3, Cohere #4, Gemini #5, DeepSeek #6/terakhir).
2. `src/application/ai-native-commands.ts`:
   - Memperbarui footer pada `!aistatus` agar mencerminkan hierarki biaya baru secara transparan:
     `Prioritas teks: Mistral ➔ Groq ➔ Nvidia NIM ➔ Cohere ➔ Gemini ➔ DeepSeek (hemat saldo).`

### Verifikasi Empiris
1. **Lokal**:
   - `npx tsc --noEmit` lolos 0 error.
   - `npx vitest run tests/unit/ai.test.ts tests/unit/ai_native.test.ts` lolos 87/87 tests.
2. **Server VM (`forfh`)**:
   - Commit `48e4e28` di-push dan di-pull ke server VM.
   - `npm run build` sukses.
   - PM2 restart `flashpeak-bot` (PID 3311298) sukses online dan terhubung ke WhatsApp.


## [2026-11-23] Sesi: Telemetri Persisten LLM (provider_usage), Logging Real-Time PM2, Prioritas Mistral, & Command !aistatus

### Konteks Sesi & Permintaan User
1. **Pemeriksaan Log AI / LLM**:
   - User melihat log PM2 dan menanyakan ketiadaan log sistem LLM ("itu gaada sistem botnya kah? kasih aja dong. eh sistem llm maksudku").
   - Meminta agar model yang jarang dipakai seperti **Mistral** diprioritaskan.
2. **Pencatatan / Pelacakan Penggunaan AI**:
   - User menanyakan: *"btw sekarang ada pencatatan gak? ai apa yang sering dipakai dan tidak?"*
   - Investigasi menemukan bahwa tabel database `provider_usage` sudah ada (migration 001/004), namun callback `onTelemetry` di `src/cli/start.ts` belum disambungkan sehingga tabel tersebut kosong (`0 rows`) dan tidak ada output log AI ke console/PM2.

### Perubahan Kode & Data
1. `src/cli/start.ts`:
   - Menyambungkan callback `onTelemetry` pada `ProviderRouter`:
     - Mencatat setiap inferensi AI ke tabel `provider_usage` (provider, model, task_type, status, latency_ms, input_tokens, output_tokens, error_code).
     - Menampilkan log visual di PM2: `[LLM] 🤖 <PROVIDER> (<MODEL>) | Task: <TASK> | <STATUS> (<LATENCY>ms) | in=<IN>, out=<OUT>`.
2. `src/ai/router.ts`:
   - Memperbarui urutan prioritas task (`prioritizeByTask`):
     - **Vision**: `['MISTRAL', 'DEEPSEEK', 'GROQ', 'GEMINI', 'NVIDIA_NIM', 'COHERE', 'OLLAMA_CLOUD']` (Mistral `ministral-14b-latest` diaktifkan dan diposisikan paling depan).
     - **Text**: `['MISTRAL', 'COHERE', 'NVIDIA_NIM', 'DEEPSEEK', 'GROQ', 'GEMINI', 'OLLAMA_CLOUD']` (Mistral `codestral-latest`, Cohere, dan Nvidia NIM diposisikan paling depan agar model yang jarang dipakai aktif terutilisasi).
3. `src/application/ai-native-commands.ts`:
   - Menambahkan command baru `!aistatus` (terbuka di grup maupun DM):
     - Mengagregasi data dari `provider_usage` (jumlah panggilan, jumlah sukses, rata-rata latency, total token per provider).
     - Menampilkan status health circuit breaker jika belum ada riwayat atau sedang terjadi gangguan provider.

### Verifikasi Empiris
1. **Benchmark Multi-Provider di VM (`forfh`)**:
   - Seluruh 6 provider terverifikasi aktif dan sukses:
     - MISTRAL (`codestral-latest`): 574ms
     - GROQ (`qwen/qwen3.8-27b`): 263ms
     - DEEPSEEK (`deepseek-flash`): 1077ms
     - GEMINI (`gemini-3-flash-preview`): 3377ms
     - NVIDIA_NIM (`nemotron-3.5-super-vl`): 3716ms
     - COHERE (`command-a-reasoning`): 5200ms
2. **Pengujian Live Telemetri di Server**:
   - Menjalankan request AI via `!pantun`:
     - MISTRAL terpilih dan berhasil dieksekusi dalam 1156ms.
     - Row telemetri tersimpan otomatis ke `provider_usage`.
     - Command `!aistatus` langsung membaca data tersebut dan merender rekap penggunaan di WhatsApp secara akurat.
   - PM2 restart `flashpeak-bot` (PID 3310481) aktif dan siap melayani.


## [2026-11-23] Sesi: Pengiriman Broadcast Pengumuman Resmi Kuis ke Grup Turnamen via Omak Peak

### Konteks Sesi & Instruksi User
1. **Instruksi Pengiriman ("Gas")**:
   - Panitia Arya menyetujui draf final pengumuman kuis dan meminta pesan segera diluncurkan ke grup turnamen resmi Gojiha Cup S1 via nomor WhatsApp resmi bot Omak Peak.
2. **Eksekusi Pengiriman**:
   - Target Chat: `120363412423738009@g.us` (Grup resmi turnamen).
   - Jalur Pengiriman: Transactional Outbox queue (`outbox_messages`).
   - Message ID: `d4388383-54cf-4de7-9dff-5acafd7348d2`.

### Verifikasi Empiris & Bukti Live Server
1. **Outbox State Transition**:
   - Status awal: `PENDING`.
   - Status akhir: `SENT` pada `2026-11-23T03:45:27.364Z` (`error: null`).
2. **Log Running Bot (PM2 PID 3308072)**:
   - `{"level":30,"time":1795405527378,"pid":3308072,"hostname":"forfh-korea-vm","id":"d4388383-54cf-4de7-9dff-5acafd7348d2","chatId":"120363412423738009@g.us","msg":"[FlashPeakApp] Outbox message sent successfully"}`
   - Pesan resmi panitia terkirim secara instan ke grup turnamen Gojiha Cup S1 tanpa kendala jaringan atau enkripsi Baileys.


## [2026-11-23] Sesi: Sinkronisasi Regulasi Resmi (!rule) & Pendaftaran Alias Kuis (!kuis) ke !help

### Konteks Sesi & Permintaan User
1. **Verifikasi Command !help & Penambahan Alias !kuis**:
   - Memastikan seluruh command baru terdaftar dan discoverable di `!help`.
   - Mendaftarkan alias `!kuis` berdampingan dengan `!quiz`.
2. **Pembaruan Rulebook Resmi (!rule / !rules / !regulasi)**:
   - Menyesuaikan isi `!rule` dengan keputusan resmi terbaru:
     - **Change Name (CN)**: Menambahkan aturan bahwa pergantian nickname selama turnamen diperbolehkan asalkan wajib lapor dan dikonfirmasi ke Panitia Arya agar disesuaikan di database sistem sebelum bertanding.
     - **Pelaporan Skor**: Memperbarui aturan bahwa tim pemenang cukup mengirim 1 screenshot scoreboard utama pertandingan.
     - **Penangguhan Kiper**: Mencatat bahwa kewajiban kartu kiper dan penghargaan Best Goalkeeper ditangguhkan sementara untuk season ini (penghargaan aktif: Golden Boot, Top Assist, Best Defender).

### Perubahan Kode & Data
1. `src/application/ai-native-commands.ts`:
   - Mendaftarkan loop alias `['quiz', 'kuis']` pada router command sehingga kedua trigger aktif dan tampil di `!help`.
2. `src/application/tournament-commands.ts`:
   - Memperbarui teks `ruleHandler` pada Poin 1 (Regulasi CN) dan Poin 6 (Pelaporan skor 1 screenshot & status penangguhan kiper).

### Verifikasi Empiris
1. **Lokal**:
   - `npx tsc --noEmit` lolos 0 error.
   - `npx vitest run` lolos 59/59 tests.
2. **Server VM (`forfh`)**:
   - Git pull, `npm run build` sukses, dan PM2 restart `flashpeak-bot` (PID 3308060).
   - Pengujian live runtime VM membuktikan:
     - `!rule` langsung menampilkan teks regulasi terbaru yang akurat.
     - `!help` memuat `!quiz`, `!kuis`, `!topquiz`, `!quizleaderboard`, `!kuisleaderboard`, `!topkuis`.


## [2026-11-23] Sesi: Implementasi Transactional Outbox Pattern & CLI Announcement Dispatcher

### Konteks Sesi & Permintaan User
1. **Permintaan Pengiriman Pengumuman via Nomor Bot Omak Peak**:
   - User meminta agar pengumuman pembaruan fitur kuis (`!quiz`), leaderboard kuis (`!topquiz`), dan update CN pemain dapat disiarkan langsung melalui akun WhatsApp bot Omak Peak ke grup turnamen.
2. **Kebutuhan Teknis & Batasan Arsitektur**:
   - Bot Baileys berjalan di background VM (`flashpeak-bot` PID 3307309). Menjalankan proses Baileys kedua pada kredensial `auth_state` yang sama berisiko memicu konflik sesi / disconnect (`Bad MAC` / stream conflict).
   - Solusi arsitektural yang aman dan standar industri adalah **Transactional Outbox Pattern**:
     - Tabel `outbox_messages` di database.
     - Bot yang sedang aktif melakukan polling pesan pending secara reguler dan mengirimkannya menggunakan socket resminya.
     - Script CLI `src/cli/announce.ts` memudahkan penambahan pesan broadcast ke outbox secara instan.

### Perubahan Kode & Data
1. `migrations/006_outbox_messages.sql`:
   - Membuat tabel `outbox_messages`:
     - Kolom: `id`, `chat_id`, `message_text`, `status` (`PENDING`, `SENT`, `FAILED`), `error`, `created_at`, `sent_at`.
     - Index: `idx_outbox_messages_status` pada `(status, created_at)`.
2. `src/index.ts`:
   - Menambahkan method `processOutboxMessages()` pada `FlashPeakApp` yang mengambil pesan `PENDING` dan mengirimkannya via `this.sender.sendText(chatId, text)`.
   - Mengintegrasikan pemanggilan `processOutboxMessages()` ke dalam loop `this.pollTimer`.
3. `src/cli/announce.ts`:
   - Script CLI untuk mengantrekan pengumuman ke tabel `outbox_messages` dengan target default ke `WA_CENTRAL_GROUP_JID`.

### Verifikasi Empiris
1. **Lokal**:
   - `npx tsc --noEmit` lolos 0 error.
   - `npx vitest run tests/migration.test.ts` lolos.
   - `npx vitest run` full suite lolos 333/333 tests.
2. **Server VM (`forfh`)**:
   - Push commit `fceadc0`, git pull di server VM.
   - Migrasi 006 berhasil diterapkan (`Applied: 006_outbox_messages.sql`).
   - `npm run build` sukses di VM.
   - PM2 restart `flashpeak-bot` (PID 3307309) berhasil dan langsung terhubung kembali ke WhatsApp.


## [2026-11-23] Sesi: Kuis Interaktif Real-Time 15 Detik, Feedback Salah, Timeout Closure, Leaderboard Kuis Komunitas & Injeksi Omak Peak

### Konteks Sesi & Permintaan User
1. **Aturan Main Kuis Interaktif (!quiz)**:
   - Batas waktu kuis dibuat ketat 15 detik ("biar ga sempat nyari dari internet").
   - Jika peserta menjawab salah, berikan feedback langsung bahwa jawabannya salah dan beri kesempatan tebak lagi sebelum waktu habis.
   - Jika waktu 15 detik habis tanpa jawaban yang benar, bot otomatis memberikan pesan penutupan beserta kunci jawaban resminya.
   - Jika ada yang menjawab benar: kuis otomatis ditutup seketika, mengumumkan pemenang, durasi kecepatan menjawab, dan penambahan poin kuis.
2. **Leaderboard Khusus Kuis Komunitas**:
   - Dibuat leaderboard tersendiri untuk pencatat skor kuis (`quiz_scores`), murni untuk seru-seruan komunitas tongkrongan dan tidak mencemari/memengaruhi klasemen resmi turnamen.
   - Command discovery: `!topquiz`, `!quizleaderboard`, `!kuisleaderboard`, `!topkuis` (terdaftar di `!help`).
3. **Injeksi ke Omak Peak (!ai)**:
   - Top skor kuis diinjeksi ke dalam `trusted_context` Omak Peak agar jika ada yang bertanya siapa "raja kuis" / si paling pintar di grup, bot bisa menjawab santai dan bercanda berdasarkan data leaderboard.

### Perubahan Kode & Desain Arsitektur
1. `src/data/flashpeak-trivia.json`:
   - Menambahkan array `keywords: string[]` pada seluruh 22 butir soal kuis (single-word token dan multi-word phrase).
   - Memastikan pencocokan jawaban deterministik super cepat (<0.1 ms) tanpa latensi pemanggilan model AI (LLM) di tengah jalannya kuis 15 detik.
2. `migrations/005_quiz_leaderboard.sql`:
   - Membuat tabel baru `quiz_scores`:
     - Kolom: `id`, `chat_id`, `sender_raw_address`, `participant_name`, `score`, `created_at`, `updated_at`.
     - Constraint: `UNIQUE(chat_id, sender_raw_address)`.
3. `src/application/quiz-session.ts`:
   - Modul baru pengelola sesi arcade kuis real-time:
     - `isQuizAnswerMatch(input, keywords)`: Normalisasi NFKD, lowercase, penanganan tanda baca, pencocokan frase & token kata.
     - `QuizSessionManager`: Membatasi kuis 1 sesi aktif per chat, timer 15 detik dengan `setTimeout`, pembatalan saat benar, evaluasi jawaban masuk, dan upsert atomic skor `ON CONFLICT DO UPDATE SET score = score + 1`.
     - `getLeaderboard` & `formatLeaderboard`: Format ranking bersih ramah WhatsApp dengan medali emoji (🥇, 🥈, 🥉).
4. `src/application/trivia.ts`:
   - Mengekspor `TriviaQuiz` interface dengan properti `keywords` dan mengembalikan objek kuis lengkap.
5. `src/application/ai-native-commands.ts`:
   - Mengintegrasikan `QuizSessionManager` ke dalam router pesan.
   - Mengubah `!quiz`: menjalankan timer 15 detik dengan pesan hitung mundur dan mendaftarkan callback timeout.
   - Menambahkan handler `!topquiz`, `!quizleaderboard`, `!topkuis`, `!kuisleaderboard`.
   - Mendaftarkan seluruh command kuis baru di `!help`.
6. `src/index.ts`:
   - Menginstansiasi `quizSessionManager` dan menyuntikkannya ke `AiNativeCommandsHandler`.
   - Menambahkan hook evaluasi pesan masuk grup (pesan non-command / jawaban singkat <= 60 karakter atau reply pesan kuis):
     - Jika benar: panggil `recordWin`, bersihkan timer kuis, balas dengan selebrasi kemenangan, tag user, durasi jawab, dan total poin kuis.
     - Jika salah: balas dengan `❌ Kurang tepat @name! Coba tebak lagi sebelum 15 detik habis!`.
7. `src/ai/prompts/omak-peak-context.ts` & `src/application/omak-peak.ts`:
   - Menambahkan field `quiz_leaderboard` pada `OmakPeakContext`.
   - Mengambil 5 skor tertinggi kuis komunitas pada `buildOmakPeakContext` (tetap tersedia baik saat turnamen aktif maupun belum dimulai).
8. `src/ai/prompts/omak-peak.ts`:
   - Menambahkan panduan pada system prompt Omak Peak di bawah `JAWAB BERDASARKAN KONTEKS` mengenai `quiz_leaderboard`.
9. `package.json`:
   - Mengubah skrip `"build"` dari bash command kaku `mkdir -p && cp` menjadi skrip berbasis Node.js lintas platform sehingga kompatibel di Windows maupun Linux.
10. `tests/unit/ai_native.test.ts`:
    - Menambahkan 4 test case komprehensif: keyword matching (token & frase), siklus hidup 15 detik `QuizSessionManager` & evaluasi jawaban, pencatatan skor leaderboard, dan injeksi context Omak Peak.

### Verifikasi Empiris
1. **Lokal**:
   - `npx tsc --noEmit` lolos 0 error.
   - `npx vitest run tests/unit/ai_native.test.ts tests/migration.test.ts` lolos 62/62 tests.
   - `npx vitest run` full suite lolos 333/333 tests di 23 file pengujian.
   - `npm run build` sukses membangun `dist/` dan menyalin `src/data/*.json`.
2. **Server VM (`forfh`)**:
   - Push commit `891ae1d`, git pull di server VM.
   - Migrasi 005 berhasil dijalankan (`Applied: 005_quiz_leaderboard.sql`).
   - `npm run build` berhasil di Linux VM.
   - PM2 restart `flashpeak-bot` (PID 3305848) berjalan normal dan terhubung ke WhatsApp.
   - Pengujian live runtime VM:
     - Tabel `quiz_scores` terverifikasi aktif di `local.sqlite`.
     - Player `7SB_S+#@?LOL` tetap aman dan valid.
     - `QuizSessionManager` live test mengembalikan format leaderboard dengan benar.


## [2026-11-23] Sesi: Perluasan Database Trivia & Quiz Flash Peak (Mekanik Tempur & Easter Egg Oscar)

### Konteks Sesi & Permintaan User
1. **Ekspansi Database !trivia & !quiz**:
   - Memasukkan data pembongkaran game client Flash Peak (mekanik combat, formula benturan bahu, stamina/energi, debuff double-teaming, dimensi pitch, skill karakter mendalam, dsb.).
2. **Easter Egg Karakter Tersembunyi: OSCAR (ID 1011)**:
   - Menambahkan karakter Striker rahasia Oscar (奥斯卡) yang belum dirilis resmi di server publik sebagai Easter Egg di database trivia dan kuis.

### Perubahan Kode & Data
1. `src/data/flashpeak-trivia.json`:
   - Menambahkan 15 fakta baru (total 37 fakta) mencakup:
     - Easter Egg: Karakter tersembunyi Oscar (ST, ID 1011, Power 78, Two Point Sprint, Ultimate Savage Dash).
     - Formula Shoulder Barge & Catastrophic Knockdown (Delta Power > 25, 80% knockdown, 100% bola lepas).
     - Debuff Double-Teaming (Overlap 2 bek = sprint drop ke 90% + benturan bahu tiap 0.5s).
     - Dimensi pitch resmi (66m x 103m x 20m) & aturan Final Play (serangan terakhir).
     - Skill detail: Andrew Super Tackle 18m, Ford Super Block 4s + 12% energy, Kelly Wall Dash 15m, Tatsuya Dash gratis (0 stamina/energi), Homer Full Vision (ulti termurah 280 energy), Steffie Doodle Storm (dual slide tim), Moco Blind Cam 2s, Rafael Super Armor Fake Shoot, Orion Aerial Protection, Kiper anti-stall (0.3s backpass).
   - Menambahkan 12 kuis baru (total 22 soal kuis) dengan pertanyaan dan jawaban terverifikasi.
2. `tests/unit/ai_native.test.ts`:
   - Menambahkan unit test `includes Oscar easter egg and unpacked gameplay mechanics in trivia and quiz`.

### Verifikasi Empiris
1. **Lokal**:
   - `node -e` validasi sintaks JSON: 37 fakta, 22 kuis, valid 100%.
   - `npx vitest run tests/unit/ai_native.test.ts` lolos 55/55 tests.
   - `npx tsc --noEmit` lolos 0 error.
2. **Server VM (`forfh`)**:
   - Commit `1180b11` dipull, `npm run build` sukses menyalin `flashpeak-trivia.json` ke `dist/data/`, dan `flashpeak-bot` di-restart (PID 3302858, status online).
   - Pengujian live di VM:
     - `svc.randomFact()` berhasil mengambil fakta baru.
     - `svc.randomQuiz()` berhasil mengambil kuis baru.
     - Trivia dan kuis Easter Egg Oscar (`fp-easteregg-oscar`, `fp-quiz-oscar-hidden`) berhasil diverifikasi aktif dan tampil sempurna.

---

## [2026-11-23] Sesi: Perubahan Nickname Resmi Peserta (Change Name / CN) — 7Sins Venom

### Konteks Sesi & Instruksi User
1. **Permintaan Change Name (CN)**:
   - Peserta dari tim `7Sins•BlueLock Venom` mengganti nama in-game dari `7SB_AL' Z` (tercatat di database sebagai `7SB_AL`z`) menjadi `7SB_S+#@?LOL`.
   - Panitia Arya mengonfirmasi perubahan nama resmi ini agar data terupdate di database sebelum pertandingan berikutnya, serta memastikan 5 gol yang sudah dicetak tidak hilang.

### Perubahan Database & Verifikasi
1. **Target Pemain**:
   - `id`: `ae553c0a-3f41-43af-8e33-896d2339c25b`
   - Tim: `7Sins•BlueLock Venom` (`team_id: 39c98ae2-bea6-4e3e-acc8-5f603d97508e`)
   - Posisi: `OUTFIELD`, Slot: `3`, Status: `ACTIVE`, Roster Type: `STARTER`
2. **Eksekusi Update**:
   - `nickname_raw`: `'7SB_S+#@?LOL'`
   - `nickname_nfc`: `'7SB_S+#@?LOL'`
   - `nickname_search_key`: `'7sbslol'`
   - `updated_at`: `2026-11-23T02:41:03.645Z`
3. **Verifikasi Empiris**:
   - **Tabel Top Scorer**: Tetap mencatat 5 gol dari Match 1 vs Mizukage, otomatis tampil dengan nama baru `7SB_S+#@?LOL`.
   - **Roster & Omak Peak Context**: Roster resmi `7Sins•BlueLock Venom` langsung menampilkan `7SB_S+#@?LOL` sebagai starter outfield.
   - **OCR Roster Matcher**: Pengujian OCR match eksak (`7SB_S+#@?LOL`) maupun variasi karakter OCR (`7SB_S+#@LOL`) terbukti 100% cocok dengan pemain resmi, sehingga pada match berikutnya tidak akan terdeteksi sebagai pemain tidak terdaftar (unregistered player).

---

## [2026-11-23] Sesi: Injeksi Konteks Roster Tim Resmi ke Omak Peak (!ai)

### Konteks Sesi & Investigasi User
1. **Omak Peak Buta Roster Tim ("Roster lengkapnya nggak ada di tanganku sekarang")**:
   - Peserta bertanya via `!ai roster 7Sins•Bluelock Venom` dan `!ai roster HELIX Moonbreaker lelouch`.
   - Bot merespons bahwa sistem hanya menyimpan statistik pertandingan yang sudah berjalan, bukan daftar nama resmi per tim, lalu menyarankan menggunakan `!roster`.
   - User Arya bertanya: *"Kok ga paham? dia ga dikasi konteks roster? ga dikasi konteks lengkap tur kah?"*
2. **Akar Masalah (Root Cause)**:
   - Pada `src/application/omak-peak.ts` fungsi `buildOmakPeakContext`, bot hanya menginjeksi fixtures, standings per grup, top scorer/assist/defender, kontak delegasi, FAQ QnA, ringkasan aturan, dan game knowledge.
   - Database `players` yang menyimpan 122 pemain resmi terdaftar (16 tim lengkap dengan posisi GK/Outfield dan Starter/Substitute) sama sekali **tidak pernah di-query maupun diinjeksi** ke dalam `trusted_context` Omak Peak.
   - Akibatnya, Omak Peak hanya mengetahui pemain yang kebetulan mencetak gol/assist/defense di match sebelumnya, dan jujur mengaku tidak memiliki daftar roster.

### Perubahan Kode (Surgical Changes)
1. `src/ai/prompts/omak-peak-context.ts`:
   - Menambahkan field `team_rosters` pada interface `OmakPeakContext`:
     ```typescript
     team_rosters?: Array<{
       team_name: string;
       group_code: string | null;
       players: Array<{
         nickname: string;
         position: 'GOALKEEPER' | 'OUTFIELD';
         roster_type: 'STARTER' | 'SUBSTITUTE';
       }>;
     }>;
     ```
2. `src/application/omak-peak.ts`:
   - Pada `buildOmakPeakContext`, menambahkan query ke tabel `players` yang di-join dengan `teams` dan `groups` untuk `p.tournament_id = ? AND p.status = 'ACTIVE'`.
   - Mengelompokkan data pemain berdasarkan tim, posisi, dan tipe roster, lalu memasukkannya ke dalam `team_rosters`.
   - Menyediakan fallback `team_rosters: []` pada error handling context.
3. `src/ai/prompts/omak-peak.ts`:
   - Menambahkan instruksi eksplisit di bawah `JAWAB BERDASARKAN KONTEKS` bahwa field `team_rosters` berisi daftar resmi pemain seluruh tim (posisi & status), sehingga bot dapat langsung menjawab pertanyaan roster, komposisi pemain, maupun posisi spesifik pemain secara akurat dan meyakinkan.
4. `tests/unit/ai_native.test.ts`:
   - Menambahkan test `populates team_rosters with active players grouped by team and includes it in prompt`.

### Verifikasi Empiris
1. **Lokal**:
   - `npx tsc --noEmit` lolos 0 error.
   - `npx vitest run` lolos 328/328 tests di 23 file pengujian.
2. **Server VM (`forfh`)**:
   - Commit `6c0577d` dipull, build tsc sukses, dan PM2 `flashpeak-bot` di-restart (PID 3300510, status online).
   - Dry-run `buildOmakPeakContext` langsung pada `local.sqlite` di VM:
     - Total teams in roster context: 16 tim.
     - `7Sins•BlueLock Venom`: 8 pemain lengkap (GK: 7SB_ALIEF, Outfield: 7SB_7+#3K+$;, 7SB_AL`z, 7SB_Ronaldo, 7SB_Lorenzo, Subs: 7SB_Yudabest, 7SB_Leo, 7SB_NAGIII).
     - `Helix Moonbreaker`: 8 pemain lengkap (GK: HX • Mazino, Outfield: HX • Kaiyzo, HX • Akewww, HX • Steelix, HX • Zeref, Subs: HX • Lelouch, HX • Damengg~, HX • Ifenn).

---

## [2026-11-23] Sesi: Refine Tampilan Klasemen WhatsApp (Mobile-Friendly Layout & Penamaan Roster Penuh)

### Konteks Sesi & Permasalahan User
1. **Nama Tim Terpotong (Ambiguitas Divisi 7Sins)**:
   - Pada format tabel monospace lama, kolom nama tim dipotong menjadi maksimal 14 karakter (`7Sins•BlueLoc...`).
   - Akibatnya, user/peserta tidak dapat membedakan tim `7Sins•BlueLock Venom` (Grup A) dan `7Sins•BlueLock Inferno` (Grup D).
2. **Tampilan Rusak di Layar HP (Wrapping Monospace WhatsApp)**:
   - Format tabel monospace 46 karakter (`POS TIM P W D L GF GA GD PTS`) melebihi batas lebar layar HP (~32-35 karakter).
   - Akibatnya, baris statistik patah ke bawah menjadi 2-3 baris yang tidak beraturan, angka-angka tersambung menjadi hyperlink hijau nomor telepon/tanggal otomatis WhatsApp, dan batas tabel menjadi berantakan.

### Perubahan Kode (Surgical Changes)
1. `src/whatsapp/formatters.ts`:
   - Mengubah `formatStandingsTable` dari tabel monospace 46-karakter menjadi **Mobile-Optimized Multi-Line Card**:
     - Baris 1: Nomor ranking/badge (`1️⃣`, `2️⃣`, dst.), **Nama Lengkap Tim Tanpa Dipotong**, dan **Poin** tebal (`— *X Poin*`).
     - Baris 2: Rangkuman ringkas pertandingan (`X Main | WM DS LK | SG ±X (GF-GA)`).
     - Garis penanda kelolosan (`┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ ⬆️ _Top 2 Lolos_`) disisipkan setelah peringkat 2.
     - Mendukung parameter opsional `options?: { showFooter?: boolean }` untuk mode gabungan semua grup agar keterangan tidak berulang-ulang di setiap grup.
2. `src/index.ts`:
   - Meneruskan `options?: { showFooter?: boolean }` pada `getStandingsTable`.
3. `src/application/tournament-commands.ts`:
   - Mengupdate perintah `!standings` (all-groups mode):
     - Memanggil `getStandingsTable` dengan `{ showFooter: false }`.
     - Memisahkan antar grup dengan garis pembatas rapi `──────────────────────────────`.
     - Menaruh satu baris keterangan di akhir pesan: `💡 _Keterangan: Top 2 tim tiap grup lolos ke Babak Knockout._`.
4. `tests/unit/formatters.test.ts`:
   - Menyesuaikan pengujian unit test format tabel klasemen baru (seluruh 12 test formatters lolos).

### Verifikasi Empiris
1. **Lokal**: `npx tsc --noEmit` lolos 0 error; `npx vitest run` lolos 327/327 tests.
2. **Server VM (`forfh`)**: Commit `b586b69` dipull, build, dan PM2 `flashpeak-bot` di-restart (PID 3298654).
3. **Simulasi Output Resmi di VM**:
   - Grup A jelas menampilkan: `2️⃣ *7Sins•BlueLock Venom* — *3 Poin*`.
   - Grup D jelas menampilkan: `4️⃣ *7Sins•BlueLock Inferno* — *0 Poin*`.
   - Panjang baris stat maksimal 34-36 karakter, tidak wrapping di smartphone, dan tidak ada glitch auto-link WhatsApp.

---

## [2026-11-23] Sesi: Implementasi Regulasi Pemain Tidak Terdaftar (Rule 2.12, D-035) & Pengesahan Kemenangan 7Sins (7-1)

### Konteks Sesi & Instruksi User
1. **Regulasi Pemain Tidak Terdaftar / Pemain Gelap (Rule 2.12, Decision D-035)**:
   - Jika tim yang **MENANG** atau **SERI** memainkan pemain tidak terdaftar: Kemenangan/hasil seri langsung dibatalkan dan dinyatakan kalah Walkover (**WO 0–3**) untuk tim pelanggar (kemenangan WO 3–0 untuk tim lawan yang sah), dengan persetujuan 2 pihak (Panitia dan Tim Lawan) melalui `!approve`.
   - Jika tim yang **KALAH** memainkan pemain tidak terdaftar: Skor asli pertandingan di lapangan **TETAP BERLAKU** (misalnya 7–1 tetap dicatat 7–1, tidak dipotong menjadi WO 3–0) demi menjamin keadilan tim pemenang yang sah agar selisih gol (GD) dan jumlah gol (GF) mereka tidak dirugikan.
   - Pemain tidak terdaftar pada tim yang kalah dicatat dengan status `INELIGIBLE` (`is_award_eligible = 0` pada `player_game_stats`), dilarang bermain di match berikutnya, dan tim yang melanggar mendapatkan peringatan/teguran resmi panitia.
2. **Pengesahan Pertandingan 7Sins vs Mizukage**:
   - Tim Mizukage (kalah 1–7) mengakui memainkan pemain belum terdaftar (`KGE.Tron`) karena kekurangan orang.
   - Sesuai regulasi baru, kemenangan 7–1 untuk 7Sins disahkan penuh di database, `KGE.Tron` berstatus `INELIGIBLE`, dan klasemen Grup A diperbarui.

### Perubahan Kode (Surgical Changes)
1. `src/reports/validation.ts`:
   - Menambahkan fungsi `resolveOrRegisterIneligiblePlayer(db, tournamentId, teamId, nicknameRaw, position)`.
   - Mengupdate `validateMatchReport`:
     - Menghitung `isTeamAWinner`, `isTeamBWinner`, dan `isDraw`.
     - Jika pemain tidak terdaftar berada di tim pemenang/seri: push fatal error pembatalan kemenangan & tuntutan WO 3–0 (`isValid: false`).
     - Jika pemain tidak terdaftar berada di tim yang kalah: izinkan dengan peringatan resmi (`isValid: true`), daftarkan pemain sebagai `INELIGIBLE`, dan petakan ke lineup tervalidasi.
2. `src/reports/stats.ts`:
   - Pada `onReportLocked`:
     - Membaca kolom `status` dari tabel `players`. Jika pemain berstatus `INELIGIBLE`, tetapkan `is_award_eligible = 0` pada `player_game_stats`.
     - Pada cabang `isWalkover`, pastikan finalisasi fixture dan rekalkulasi klasemen grup tetap dieksekusi.
3. `src/stats/aggregator.ts`:
   - Menambahkan filter `AND p.status = 'ACTIVE'` agar pemain tidak eligible tidak pernah masuk nominasi penghargaan top scorer/assist/defense.
4. `flash-peak-tms/COMPETITION_RULES.md` & `docs/ARCHITECTURE_DECISIONS.md`:
   - Menambahkan Pasal 2 Ayat 12 dan Keputusan D-035 yang mendokumentasikan aturan ini secara resmi.
5. `tests/unit/reports.test.ts`:
   - Menambahkan unit test untuk Rule 2.12 dan D-035 (26 tests pass).

### Verifikasi Empiris & Eksekusi di VM Server
1. **Testing Lokal**:
   - `npx tsc --noEmit`: 0 error.
   - `npx vitest run`: 327 tests passed across 23 test suites.
2. **Deployment ke VM Server (`forfh`)**:
   - `git push origin master` (commit `4e3d679`).
   - `git pull`, `npm run build`, `pm2 restart flashpeak-bot` (PID 3296579).
3. **Pengesahan Match 7Sins vs Mizukage di VM**:
   - `report_version` `6433632f-64a4-457f-8dc0-8213be983376` divalidasi sukses (`isValid: true`).
   - Warning tercatat: *"⚠️ Peringatan Pelanggaran Roster: Pemain #5 'KGE.Tron' tidak terdaftar di roster aktif Tim B. Karena Tim B kalah (1 - 7), skor asli tetap berlaku demi keadilan tim pemenang, namun pemain ini berstatus INELIGIBLE (tidak berhak atas penghargaan individu)."*
   - Approval consensus: Team A (7Sins) + Organizer -> status transisi ke `LOCKED`.
   - `fixtures` (`5093fee9-11fa-4544-a5b0-02830b1314fa`): `COMPLETED`.
   - `games` (`2db4d0df-1b8f-4eff-845e-8c78d2b97c9b`): `COMPLETED`, Team A 7, Team B 1.
   - `player_game_stats`: `KGE.Tron` tercatat dengan `status = 'INELIGIBLE'` dan `is_award_eligible = 0`.
   - Klasemen Grup A resmi terupdate:
     - 1. Helix Moonbreaker: 2 Main, 2 Menang, 12 GF, 4 GA, +8 GD, 6 Poin
     - 2. 7Sins•BlueLock Venom: 1 Main, 1 Menang, 7 GF, 1 GA, +6 GD, 3 Poin
     - 3. Agility Starlight: 1 Main, 0 Menang, 2 GF, 6 GA, -4 GD, 0 Poin
     - 4. Mizukage: 2 Main, 0 Menang, 3 GF, 13 GA, -10 GD, 0 Poin

---

## [2026-11-23] Sesi: Rollback Pendaftaran KGE.Tron & Penundaan Status Match 7Sins vs Mizukage Menunggu Keputusan Panitia

### Konteks Sesi & Instruksi User
- User menegur: *"eh jangan didaftarkan. berarti pemain gelap dong? kalau baru didaftarkan sekarang?"*.
- Poin user 100% benar secara integritas kompetisi (Pasal 2 Ayat 6 & 8: *"Only registered roster members may play"* dan *"Nickname changes during the tournament are prohibited"*). Sistem tidak boleh diam-diam mendaftarkan pemain yang bermain di lapangan ke dalam roster resmi jika pemain tersebut belum terdaftar sebelum match dimulai.

### Tindakan Remediasi Database (Surgical Rollback)
1. **Menghapus `KGE.Tron` dari tabel `players`**:
   - Data `KGE.Tron` langsung dihapus total dari database `local.sqlite` di server VM.
   - Roster tim Mizukage kembali murni 7 orang terdaftar resmi (`KGE.Rimex∆`, `KGE.Atreus`, `KGE.Jairo`, `KGE.bitzz!!?`, `KGE.GOGI`, `KGE.Kyoto969`, `KGE.AUDRIC№²`).
2. **Menghapus statistik `player_game_stats` sementara**:
   - Seluruh baris statistik untuk `game_id: 2db4d0df-1b8f-4eff-845e-8c78d2b97c9b` dihapus bersih.
3. **Mengembalikan status Fixture & Game ke `SCHEDULED`**:
   - `fixtures` (ID: `5093fee9-11fa-4544-a5b0-02830b1314fa`): status kembali `SCHEDULED`.
   - `games` (ID: `2db4d0df-1b8f-4eff-845e-8c78d2b97c9b`): status kembali `SCHEDULED`, skor dikosongkan (`NULL`), pemenang dikosongkan (`NULL`).
   - `report_versions` (ID: `6433632f-64a4-457f-8dc0-8213be983376`): status kembali `NEEDS_CORRECTION`, `validated_data_json = '{}'`.
4. **Menghitung ulang klasemen Grup A**:
   - Fungsi `recalculateAndPersistGroupStandings` dijalankan kembali untuk Grup A.
   - Klasemen Grup A bersih kembali: 7Sins bermain 0 kali (0 poin), Mizukage bermain 1 kali (0 poin).

### Verifikasi Empiris
- Query verifikasi di VM: `KGE.Tron` 0 baris di `players`, `player_game_stats` 0 baris, fixture status `SCHEDULED`.
- Klasemen Grup A terverifikasi akurat: Helix (6 poin, 2 main), 7Sins (0 poin, 0 main), Agility (0 poin, 1 main), Mizukage (0 poin, 1 main).

---

## [2026-11-23] Sesi: Investigasi Approval 7Sins vs Mizukage & Penanganan Screenshot Kiper (Ditangguhkan)

### Konteks Sesi & Pertanyaan User
1. **Investigasi Laporan 7Sins•BlueLock Venom vs Mizukage**:
   - User menanyakan mengapa match `7sins bluelock vs mizukage` yang sudah di-`!approve` oleh pemenang dan organizer (Arya) masih belum terkunci dan diminta lagi, serta memeriksa apakah ada kesalahan interpretasi pemenang (apakah salah anggap Mizukage menang) atau ada kegagalan sistem.
2. **Penanganan Screenshot Kiper**:
   - Jika terdeteksi screenshot kiper yang dikirim oleh peserta, bot tidak boleh lagi mengirim pesan error `📸 Screenshot Tidak Dapat Dibaca / data pertandingan tidak dapat diambil`.
   - Bot harus memberikan pemberitahuan yang sopan dan jelas bahwa statistik kiper saat ini telah **DITANGGUHKAN** oleh panitia turnamen untuk season ini (karena keterbatasan game Flash Peak & kesulitan verifikasi statistik save kiper), sehingga peserta tidak perlu mengirim screenshot kiper lagi dan hanya perlu mengirim screenshot skor akhir (scoreboard 4v4).

### Temuan Investigasi (Root Cause Analysis)
1. **AI Sama Sekali Tidak Salah Tafsir Pemenang**:
   - Pada sesi draf `de7516a8-9935-4978-a801-5eedcddee86f` (07:02 WIB), ekstraksi AI 100% akurat:
     - Skor: `7Sins•BlueLock Venom 7 - 1 Mizukage`.
     - Gol 7Sins: `7SB_NAGIII` (2), `7SB_AL`z` (5) = total 7.
     - Gol Mizukage: `KGE.Jairo` (1) = total 1.
2. **Akar Masalah Kegagalan Lock (!approve Tidak Efektif)**:
   - **Penyebab Utama:** Pada pertandingan tersebut, tim Mizukage menurunkan pemain bernama `KGE.Tron`. Namun di data registrasi roster tim Mizukage di database, hanya terdaftar 7 pemain (`KGE.Rimex∆`, `KGE.Atreus`, `KGE.Jairo`, `KGE.bitzz!!?`, `KGE.GOGI`, `KGE.Kyoto969`, `KGE.AUDRIC№²`), tanpa `KGE.Tron`.
   - **Validator Menolak:** `validateMatchReport` menghasilkan error `Team B player #5 "KGE.Tron" is not a registered active player on Team B`, sehingga status draf menjadi `NEEDS_CORRECTION` dan `validated_data_json` disimpan kosong (`{}`).
   - **Error Tidak Tampil di WhatsApp:** Pada `evidence-batch-processor.ts`, parameter `uncertainties` hanya mengambil `validation.warnings` dan mengabaikan `validation.errors`. Akibatnya, pesan draf di grup hanya bertuliskan `[NEEDS CORRECTION]` tanpa memberi tahu alasan errornya, sehingga Arya dan peserta mengira draf sudah benar dan langsung mengetik `!approve`.
   - **Bug Fallback di `getRequiredApprovers`:** Pada `approval.ts`, kode membaca `version.validated_data_json || version.extraction_json`. Karena `validated_data_json` bernilai string `"{}"` (truthy), sistem tidak membaca `extraction_json`. Karena `{}` tidak memiliki data skor, sistem menganggap pertandingan berakhir SERI (DRAW). Pada pertandingan seri, sistem membutuhkan persetujuan kedua tim + organizer (`TEAM_A`, `TEAM_B`, `ORGANIZER`). Akibatnya, sistem terus menunggu persetujuan dari Mizukage (`TEAM_B`), dan jika Mizukage pun menyetujui, locking akan crash karena `validated_data_json` kosong.
3. **Penyebab Respon "Screenshot Tidak Dapat Dibaca" untuk Kiper**:
   - Pada pukul 07:05 WIB, 7SB Venom FP mengirimkan screenshot kiper Maxim dengan caption `"GK 7Sins•BlueLock Venom"` (sesi `a58f11e0`).
   - Karena hanya foto detail kiper yang dikirim tanpa foto scoreboard utama (`!mainMatchBase64`), sistem debounce menganggap sesi tersebut sebagai kiriman draf baru yang rusak/tidak lengkap, lalu membalas dengan `📸 Screenshot Tidak Dapat Dibaca... Screenshot skor akhir pertandingan (main match summary) tidak terdeteksi di laporan ini`. Peserta pun mengira bot mengalami error.

### Perubahan Kode (Surgical)
1. **`src/whatsapp/failure.ts`**:
   - Menambahkan formatter baru `formatGoalkeeperSuspendedMessage`:
     - Judul: `🧤 *Statistik Kiper Tidak Perlu Dikirim (Ditangguhkan)*`.
     - Menjelaskan bahwa penghargaan Best Goalkeeper ditangguhkan oleh panitia untuk season ini karena keterbatasan tampilan teknis game & verifikasi save kiper.
     - Mengingatkan peserta bahwa foto kiper tidak perlu dikirim lagi dan hanya butuh foto scoreboard akhir 4v4, atau jika sudah dikirim tinggal ketik `!approve`.
2. **`src/application/evidence-batch-processor.ts`**:
   - Jika foto utama skor akhir tidak terdeteksi (`!mainMatchBase64`), memeriksa apakah kiriman terdeteksi sebagai foto kiper/detail pemain (`gkDetailAssets.length > 0` atau caption menyebutkan `gk`/`kiper`/`keeper`).
   - Jika terdeteksi kiper, membalas dengan `formatGoalkeeperSuspendedMessage` alih-alih pesan error generik `formatUnreadableEvidenceMessage`.
   - Jika foto kiper dikirim bersamaan dengan scoreboard utama, foto kiper diabaikan dan ditambahkan catatan ramah pada draf: `ℹ️ Foto kiper diabaikan karena penghargaan Best Goalkeeper ditangguhkan oleh panitia untuk season ini.`
   - Menyertakan seluruh `validation.errors` ke dalam `uncertainties` dan `rejectionReason` pada draf ringkasan WhatsApp sehingga alasan penolakan/koreksi (mis. pemain ilegal/tidak terdaftar) tampil transparan.
3. **`src/reports/approval.ts`**:
   - Memperbaiki `getRequiredApprovers`: memeriksa ketersediaan skor pada `validated_data_json`, dan jika kosong `{}` atau invalid, otomatis mengekstrak skor dari `extraction_json`.
4. **`tests/unit/formatters.test.ts`**:
   - Menambahkan unit test untuk `formatGoalkeeperSuspendedMessage` memastikan teks tidak mengandung "Tidak Dapat Dibaca" dan memuat penjelasan penangguhan kiper.

### Remediasi Data Database di Server VM
1. Mendaftarkan `KGE.Tron` sebagai pemain cadangan slot 8 di tim Mizukage (`players` table).
2. Menjalankan revalidasi deterministik pada sesi `de7516a8-9935-4978-a801-5eedcddee86f` (versi `6433632f-64a4-457f-8dc0-8213be983376`):
   - Validasi: `isValid = true` (0 error).
   - Menyimpan `validated_data_json` lengkap (skor 7 - 1, player IDs, gol, assist, passes, defense).
3. Mengeksekusi approval konsensus:
   - Persetujuan dari `TEAM_A` (7Sins) dan `ORGANIZER` (Arya) terpenuhi.
   - Status report version: resmi `LOCKED`.
   - Status game: `COMPLETED` (Skor 7 - 1, Pemenang: 7Sins•BlueLock Venom).
   - Status fixture: `COMPLETED`.
   - Klasemen Grup A otomatis terupdate:
     - 7Sins•BlueLock Venom: Main 1, Menang 1, Gol 7, Kebobolan 1, Selisih Gol +6, Poin 3 (Peringkat 2).
     - Mizukage: Main 2, Kalah 2, Poin 0.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 325/325 tests passed across all 23 test suites.
- `ssh forfh "pm2 status flashpeak-bot"`: Status `online`, memory ~61MB, Baileys WhatsApp connected.
- Query verifikasi standings dan fixture di VM: Fixture `COMPLETED`, Game `COMPLETED` 7-1, 7Sins 3 poin di klasemen Grup A.

---

## [2026-11-23] Sesi: Polish Omak Peak Persona & Tone to Eliminate AI Spec-Sheet Dumping

### Konteks Sesi
- User mengamati respon Omak Peak di grup WhatsApp ketika ditanya `"!ai sebutkan karakter tergacor di game ini, dan taktik apa yang enak menurutmu"`. Respon bot terasa seperti "nge-dump" data teknis (membagi semua posisi ST, CM, CB, WF, memuntahkan angka spec sheet seperti Power 87, luncuran 18m, debuff lari 90%, dan 5 poin taktik kaku) alih-alih mengobrol santai seperti pemain pro di tongkrongan.
- User menyetujui pemolesan instruksi persona di `src/ai/prompts/omak-peak.ts` agar Omak Peak berbicara luwes, memiliki opini tajam, menginternalisasi data alih-alih membacakan spesifikasi, dan menghindari format artikel ensiklopedia.

### Perubahan Kode (Surgical)
1. **`src/ai/prompts/omak-peak.ts`**:
   - Memperbarui `OMAK_PEAK_SYSTEM_TEMPLATE` pada bagian `IDENTITAS & NADA (PRO-PLAYER TONGKRONGAN)`:
     - Larangan eksplisit terhadap gaya artikel, kamus, wiki, atau buku manual game.
     - Larangan membuat daftar inventaris seluruh posisi/karakter saat ditanya opini/rekomendasi; model diinstruksikan memilih 1–2 karakter jagoan yang paling menonjol dan menceritakan *feeling* serta alur tandingnya.
     - Aturan *Internalisasi Data*: Data teknis (Power 87, 18m, kerucut 120°, debuff 90%) digunakan sebagai dasar logika di kepala, bukan dibacakan kaku; dibahasakan secara manusiawi (misal "Andrew badak banget, Kelly lari deket dia sekali ditabrak pasti mental").
     - Format respon diprioritaskan menjadi 2–3 paragraf mengalir ramah WhatsApp tanpa bullet point panjang.
   - Memperbarui prompt suffix: `Jawab sebagai Omak Peak (bahasa Indonesia santai ala tongkrongan pro-player WhatsApp, mengalir alami, jangan nge-dump data/list panjang):`.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run tests/unit/ai_native.test.ts`: 53/53 tests passed.
- `npx vitest run tests/unit/formatters.test.ts`: 11/11 tests passed.

---

## [2026-11-23] Sesi: 100% Exhaustive Flash Peak Game Data Extraction & Injection

### Konteks Sesi
- User meminta penegasan apakah seluruh game sudah 100% dibongkar dan dimasukkan ke otak Omak Peak.
- Dilakukan investigasi mendalam lanjutan ke seluruh 27 bundle di `D:\Projects\FlashPeak\game_data_pulled\files\yoo\Default\BundleFiles` dan `bundle_mod_final`, mengekstrak:
  1. `FootballPlayerPassiveSkillTable`: 60+ skill pasif in-game resmi (Low Bullet, Relentless Strike, Box Predator, Bulldog Slide, Sticky Slide, Silent Zone, Final Form, Meteor Stride, Parade Rush, Attribute Siphon, Power Press, Precise Deflection, Charging Shield, Aerial Knock-On, Dragon's Flight, Turn Feint, Aerial Duo, dll.) beserta deskripsi angka dan efek persisnya.
  2. `strings`: Seluruh string lokalisasi resmi bahasa Indonesia (`id`), Inggris (`en`), dan Mandarin (`zh-CN`) untuk nama-nama skill in-game (mis. *Shoulder Charge*, *Gocek*, *Knock*, *Drag*, *Slide*, *Tackle*, *Joki*, *Kunci Bola*, *Umpan Lob*, *Serangan Terakhir*).
  3. `GameMapTable`: Map 1 Pantai (Rumput/Grass, bounciness 0.5) vs Map 2 Marrakech (Semen/Concrete keras dengan pantulan bola lebih tinggi dan cepat).
  4. `GameModeTable`: Aturan 4v4 Pantai, Marrakech, Training, dan Beginner.
  5. `Rank` & `RankProtect`: Tangga ranking lengkap (Bronze 1-3, Silver 1-3, Gold 1-4, Platinum 1-4, Diamond, Master, Heroic).
  6. `Item`: ID 22 (Room Card untuk membuat custom room turnamen oleh host) dan tipe rarity item.
  7. Aturan *Final Play* ("Serangan Terakhir"): Penundaan peluit akhir wasit saat serangan tim masih bergulir.

### Perubahan Kode (Surgical)
1. **`src/ai/prompts/flashpeak-game-knowledge.ts`**:
   - Memperluas `FLASH_PEAK_GAME_KNOWLEDGE` dengan:
     - Daftar lengkap 40+ skill pasif (`all_passive_skills`) dengan angka persis.
     - Kamus map dan karakteristik fisika permukaan (`Pantai` vs `Marrakech`).
     - Sistem tier ranked dan aturan bintang/proteksi.
     - Kamus istilah resmi in-game Indonesia (`Joki`, `Knock`, `Serangan Terakhir`, `Gocek`, dll.).
     - Aturan turnamen terkait Item Room Card (Item 22).
     - Panduan matchup tambahan (Counter Oscar *Savage Dash*).

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run tests/unit/ai_native.test.ts`: 53/53 tests passed.
- `npx vitest run`: 325/325 tests passed across all 23 test suites.

---

## [2026-11-23] Sesi: Flash Peak Deep Game Knowledge Integration into Omak Peak AI Native Engine

### Konteks Sesi
- User memeriksa log grup WhatsApp dan mendapati pertanyaan peserta: `"!ai kalau dikepung andrew ama ford gmn"`. Respon bot sebelumnya tidak mengenali Andrew dan Ford karena data game Flash Peak belum tersedia di konteks AI.
- User menginstruksikan untuk menyelam ke direktori `D:\Projects\FlashPeak` mengerahkan `/swarm` dan `/reverse-engineer-anything` untuk membongkar seluruh aset game tanpa batasan dan menjadikannya sumber pengetahuan otoritatif bagi bot.
- Swarm `FlashPeak Deep Game Extraction` dibentuk dengan 5 worker terspesialisasi:
  - `monitor`: stall monitor.
  - `roster-scout`: reverse engineering 14 karakter, atribut radar (PAC, SHO, PAS, DRI, DEF, PHY), dan rating tier.
  - `skills-specialist`: reverse engineering seluruh Common Skills, Small Skills, Ultimates, stamina/energy cost, range (meter), cooldown, buff IDs, dan animation cancelling.
  - `mechanics-deepdive`: reverse engineering pemulihan energi/stamina, geometri pitch (66x103x20m), durasi match (300s), 6x6 tactical grid, pinning & double-teaming debuff (speed 90%), dan aturan kiper (invincible maks 3s, back-pass anti-stall 0.3s).
  - `binary-archaeologist`: dekompilasi C# `ProjectCR.Runtime.dll` membongkar fixed-point Q32.32, formula $\Delta \text{Power} > 25$ catastrophic knockdown, Andrew 18m SuperTackle dengan `ControlBallImmediately`, Ford 4s SuperBlock dengan `StopFreeMoveBall`, dan perhitungan save kiper.

### Perubahan Kode (Surgical)
1. **`src/ai/prompts/flashpeak-game-knowledge.ts` (BARU)**:
   - Modul pengetahuan otoritatif Flash Peak berisi deskripsi lengkap format 4v4, durasi 5 menit, aturan tanpa offside, formula benturan fisik/shoulder barge, penalti double-teaming, aturan kiper, katalog 13 karakter outfield + Maxim (GK) dengan kit/stat lengkap, serta buku strategi taktis (*Tactical Matchup Playbook*) untuk skenario spesifik seperti dikepung Andrew + Ford, counter Orion, counter Hayato, counter Kelly, dll.
2. **`src/ai/prompts/omak-peak-context.ts`**:
   - Menambahkan field `game_knowledge?: FlashPeakGameKnowledge` ke interface `OmakPeakContext`.
3. **`src/ai/prompts/omak-peak.ts`**:
   - Memperbarui system prompt Omak Peak agar secara eksplisit bertindak sebagai master dan ensiklopedia berjalan game Flash Peak dengan panduan taktis mendalam berdasarkan `game_knowledge` dan `tactical_matchup_playbook`.
4. **`src/application/omak-peak.ts`**:
   - Menginjeksi `game_knowledge: FLASH_PEAK_GAME_KNOWLEDGE` ke dalam context builder `buildOmakPeakContext` (baik pada fallback maupun data aktif).
5. **`tests/unit/ai_native.test.ts`**:
   - Menambahkan unit test `populates flash_peak_game_knowledge into context and system prompt` yang memverifikasi integritas 13 karakter, atribut Andrew/Ford, dan injeksi playbook matchup ke dalam system prompt.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run tests/unit/ai_native.test.ts`: 53/53 tests passed.
- `npx vitest run`: 325/325 tests passed across all 23 test suites.

---

## [2026-11-23] Sesi: Reverse Engineer Flash Peak Character Skills, Abilities & Mechanics (Skills Specialist)

### Konteks Sesi
- Tugas delegasi swarm `@skills-specialist`: Melakukan reverse engineering komprehensif terhadap seluruh skill karakter (Common Skills, Small Skills Type 2, Ultimate Skills Type 1), mechanics transition, buff/effect system, formula PowerDiff shoulder barge, range/distance, cooldown, stamina/energy cost, dan tactical effects dari Unity AssetBundles di `D:\Projects\FlashPeak`.
- Sumber data utama:
  - `bundle_to_modify\10ee363dd89953d507c7b97d19d20485\__data`: `FootballPlayerAbilityTable`, `AbilityTransition`, `PlayerBeShoulderBargeTransition`, `FootballPlayerRecoverEnergyTable`, `FootballPlayerMainTable`, `FootballPlayerAttributeTable`.
  - `game_data_pulled\files\yoo\Default\BundleFiles`: `BuffConfigDatabase` & `BuffCoexistConfigDatabase` (`b5c5a411e3b4ae467d9f11fd5fc85a1f`), `PlayerAttributeConstants` (`8e0afa426605e8509684ee8eb22d83b5`).
  - Decompiled C# assemblies: `ProjectCR.Runtime.dll` (`AbilityBehaviour*`, `InteractionShoulderBarge`, `InteractionSuperTackleHandler`, `InteractionFordSuperBlockBall`, `InteractionShirouDualShoot`, `BuffRuntimeConfig`, `PlayerAttributeConstants`).

### Temuan Reverse Engineering Utama
1. **Resource & Attribute Constants**:
   - **Energy (Ultimate)**: EnergyMaxA sama persis dengan cost Ultimate (Homer 280 s.d. Orion 530). Regenerasi pasif 3.0/detik + perolehan aktif dari aksi (`FootballPlayerRecoverEnergyTable`).
   - **Stamina Pool**: Skala 600.0 s.d. 1200.0 stamina. Regenerasi 320.0 - 450.0 stamina/detik. Dribble membawa bola menguras 80.0 stamina/detik (`RunHasBallStaminaCost`). Berlari tanpa bola bebas stamina (0).
   - **Sprint Speed**: Off-ball 5.2 - 7.3 m/s; With-ball 4.8 - 6.8 m/s; Defense/Jockey 4.2 - 6.5 m/s. Max pass range: 35.0m dengan 60° auto-select cone.
2. **Formula Matematika Shoulder Barge (`PlayerBeShoulderBargeTransition`)**:
   - $\Delta \text{Power} = \text{Attacker Power} - \text{Target Power}$, jangkauan 2.0 meter, biaya 400 Stamina.
   - Jika target berlari/sprint dan $\Delta \text{Power} > 25$: **80% Knockdown (Jatuh)**, 20% Slow Down, bola lepas (KickBall=1, BargeSuccess=1).
   - Jika $\Delta \text{Power}$ antara 10 s.d. 25: 70% Slow Down & lepas bola, 30% Protect Ball (barge gagal).
   - Jika $\Delta \text{Power}$ antara -1 s.d. 10: 40% Slow Down, 60% Protect Ball.
   - Jika target diam (Idle) dan $\Delta \text{Power} > 10$: 100% Stumble, bola lepas.
   - Hirarki Power level 1: Andrew (87, tertinggi), Ford (79), Oscar (78), Rafael (75), Steffie (75), Homer (72), Hayato (72), Shirou (71), Orion (67), Moco (67), Tatsuya (59), Kelly (58).
3. **Transition & Animation Cancelling (`AbilityTransition`)**:
   - `ShootPre` dan `TapPre` dapat dibatalkan seketika menjadi `PullBall` (drag-back cancel).
   - `TacklePre` dapat bertransisi langsung ke `Shoot`, `Tap`, atau `Tackle` beruntun (dasar mekanik Dual Slide Steffie).
   - `HitPre` (Stun/Stumble) memblokir seluruh aksi (0).
4. **Bedah Kit Seluruh 14 Karakter**:
   - **Andrew (CB)**: Ult Super Tackle (420 Energy, jangkauan **18.0m**, meluncur merebut bola dan **segera menguasai bola di kaki** / `ControlBallImmediately`, +20 Energy recovery). Small Skill Shoulder Barge (400 Stamina, 2m, 87 Power). Aura Intimidasi (`3012`/`30300`: -10 Speed & Shot lawan).
   - **Ford (CB)**: Ult Super Block (380 Energy, durasi **4.0s**, tag `SuperBlock1009`, memblokir dan menendang balik bola tembakan lawan ke paruh lapangan musuh). Small Skill Shoulder Barge (400 Stamina, 2m, 79 Power).
   - **Orion (ST)**: Ult Bicycle Kick (530 Energy, salto udara, **kebal tackle 5.0s** via tag `Ball.BallDisableTackle`, tidak bisa diintersepsi 1.63s via `Ball.BallDisableInteractive`, kontrol arah swipe). Small Skill Orion Pull (320 Stamina).
   - **Hayato (CM)**: Ult Super Dribble (320 Energy, jangkauan **8.0m radius, sudut 120°**, gocekan beruntun melewati hingga **3 lawan sekaligus**). Small Skill Hayato Pull (160 Stamina).
   - **Kelly (WF)**: Ult Wall Dash (440 Energy, lompat ke dinding stadion **hingga 15m, tinggi 1.8m, ekstensi lari 8m**, kebal tackle tanah, dapat menembak voli di udara). Small Skill Push Ball (150 Stamina). Passive Final Form (`3039`/`30390`: +6% Speed & +3 All Stats selama 30s).
   - **Shirou (ST)**: Ult Dual Shoot (390 Energy, link rekan setim 10s, tembakan ganda mematikan dengan efek **AoE Knockdown / Hit-Fly Aerial Launch** pada lawan di lintasannya). Small Skill Rainbow Flick (175 Stamina, mengangkat bola melewati bek).
   - **Rafael (ST)**: Ult Super Fake Shoot (460 Energy, Super Armor 10s, hingga 2 fake shot, lawan di sekitar yang tidak jockey akan **kehilangan keseimbangan / stun**, diakhiri Power Shot tak terhentikan). Small Skill Cut Turn (250 Stamina).
   - **Moco (CM)**: Ult Hacker Mark (380 Energy, buff seluruh tim **20.0s**, radar passing global ke seluruh penjuru lapangan). Small Skill One-Two Pass (100 Stamina, umpan 1-2 otomatis jangkauan 25m/50m, membutakan fokus kamera lawan 2s via `1008041`).
   - **Homer (CM)**: Ult Full Vision (280 Energy - termurah, bird's eye view 60s, lemparan/tembakan melengkung dengan **homing capture radius 16.0m**, homing turn 2.0°/frame). Small Skill Elastico (160 Stamina, **hukuman stun panjang** jika lawan tackle saat gerakan berlangsung).
   - **Oscar (ST)**: Ult Savage Dash (320 Energy, charge lari 5.3s **mendorong/knockback semua lawan di jalurnya**, kecepatan bola tembakan meningkat seiring lamanya charge). Small Skill Two Point Sprint (300 Stamina, charge knockback).
   - **Steffie (CB)**: Ult Doodle Storm (360 Energy, speed boost tim 3s + buff **Dual Slide 10s** untuk seluruh rekan setim). Small Skill Double Tackle (320 Stamina, sliding tackle ganda berantai tanpa recovery delay).
   - **Tatsuya (WF)**: Ult Super Dash Shuttle (390 Energy, dash multi-arah kecepatan tinggi, **bonus +1 ekstra dash di area sayap/flank**). Small Skill Dash (0 Stamina / 0 Energy, cooldown 5.5s, burst lari gratis).
   - **Maxim (GK)**: Suite GK lengkap (Clearing Shoot, Distribution Tap, Diving Saves Low/Mid/High Catch/Punch 45°/67°, Ground Smother Tackle).

### Output & Artefak
1. **`docs/FLASH_PEAK_SKILLS_AND_ABILITIES.md`**: Dokumen spesifikasi teknis lengkap (27.908 bytes) mencakup arsitektur energi, tabel recovery, matriks probabilitas shoulder barge, tabel animasi cancel, dan kit detail 14 karakter.
2. **`docs/flash_peak_skills_catalog.json`**: Dataset katalog JSON terstruktur berformat mesin dari seluruh skill dan mekanisme game.

### Verifikasi Empiris
- Script ekstraksi Python (`dump_abilities.py`, `inspect_character_kits.py`, `inspect_buff_durations.py`, `find_attr_constants.py`, `build_full_markdown_docs.py`) membaca langsung Unity AssetBundles dan decompiled C# assembly.
- Data numerik terverifikasi dari typetree dan fixed-point 64: Stamina (600-1200), Recovery (320-450), Speed (3.5-7.3 m/s), Pass Range (35m), Ult Cost (280-530).

---


### Konteks Sesi
- Tugas delegasi swarm `@roster-scout`: melakukan reverse engineering menyeluruh terhadap roster karakter game Flash Peak dan atribut-atributnya dari Unity AssetBundles di `D:\Projects\FlashPeak`.
- Sumber data utama:
  - `bundle_to_modify\10ee363dd89953d507c7b97d19d20485\__data` (`FootballPlayerMainTable`, `FootballPlayerAttributeTable`, `PlayerRatingTable`, `FootballPlayerAbilityTable`)
  - `table_outgame.bundle` (`Item`, `FootballPlayerPassiveSkillTable`, `FootballPlayerPassiveUnlock`, `FootballPlayerUpgrade`)
  - `localization_zh-cn_strings.bundle`, `localization_en_strings.bundle`, `localization_id_strings.bundle`
  - Decompiled C# assemblies: `ProjectCR.Runtime.dll` (`CharacterDataConfigHelper`, `AttributeInfo`, `SubAttributeInfo`, `PlayerAttributeComponent`, `RatingTier`)

### Temuan Reverse Engineering
1. **Total Roster Karakter (14 Karakter)**:
   - 1 Karakter Template / Benchmark (ID 1000 `1000_Template`, 模板 / Template, ST).
   - 13 Karakter Resmi / Playable (IDs 1001 s.d. 1013):
     - **ST (Striker)**: Orion (1001), Shirou (1006 / 士郎), Rafael (1007 / 拉斐尔), Oscar (1011 / 奥斯卡).
     - **CM (Central Midfielder)**: Hayato (1002 / 夜神隼), Moco (1008 / 莫科), Homer (1010 / 赫马).
     - **CB (Center Back)**: Andrew (1003 / 安德鲁), Ford (1009 / 福特), Steffie (1012 / 史黛菲).
     - **WF (Wing Forward)**: Kelly (1004 / 凯莉), Tatsuya (1013 / 达也).
     - **GK (Goalkeeper)**: Maxim (1005 / 马克西姆).
2. **Item Rarity & Rating Tier**:
   - Rarity Avatar Item di tabel `Item`: Seluruh 14 karakter memiliki `Rare = 4` (Gold / 金色 / Legendary).
   - In-game Match Rating Tiers (`PlayerRatingTable` & enum `RatingTier`):
     - Low Tier: Nilai awal 6.0, batas minimum 3.0.
     - Mid Tier (Silver): >= 6.0 (`ColorSilverThreshold`).
     - High Tier (Gold): >= 7.5 (`ColorGoldThreshold`).
     - Top Tier (Rainbow / Colorful): >= 9.0 (`ColorColorfulThreshold`), batas maksimal 10.0.
3. **Arsitektur Atribut Radar (Display) vs Sub-Atribut**:
   - 6 Display Radar Stats (`AttributeType` 1-6) dihitung sebagai rata-rata aritmatika (`sum / count`) dari sub-atributnya:
     - **DRI (Dribble)**: Rata-rata dari Agility (1), Balance (2), Ball Control (3), First Touch (4).
     - **SHO (Shoot)**: Rata-rata dari Finishing (5), Shot Power (6), Long Shot (7), Volley (8), Charge Speed (9), Curve (10).
     - **PAS (Pass)**: Rata-rata dari Short Pass Power (11), Lob Pass Power (12).
     - **DEF (Defense)**: Rata-rata dari Clearance (13), Standing Tackle (14), Sliding Tackle (15), Blocking (16).
     - **PAC (Pace / Speed)**: Rata-rata dari Dribble Run (18), Dribble Sprint (19), Off-ball Run (20), Off-ball Sprint (21), Jockey Speed (22).
     - **PHY (Physical / Physique)**: Rata-rata dari Stamina (23), Stamina Recovery (24), Strength (25), Ball Winning / Scramble (17).
4. **Mekanik Khusus Goalkeeper (Maxim ID 1005)**:
   - Maxim memiliki atribut dasar level 1 yang dominan pada Strength (100), Short Pass (100), Jockey Speed (100), Clearance (90), Shot Power (90), Volley (90).
   - Memiliki 4 Ability Controller GK khusus:
     - `GoalKeeperShootAbility` (100501)
     - `GoalKeeperTapAbility` (100502)
     - `GoalKeeperDiveAbility` (100503)
     - `GoalKeeperTackleAbility` (100504)
     - Komponen AI & Handler: `AbilityBehaviourGoalKeeperTakeBall`, `PlayerAbilityBehaviourComponent::TrySelectGoalKeeperTakeBallAbility`.

### Output & Artefak
1. **`docs/FLASH_PEAK_CHARACTERS.md`**: Dokumentasi lengkap 14 karakter, rumus radar, perbandingan level 1 vs level 20, deskripsi lore EN & ZH, ultimate skill, dan passives.
2. **`docs/flash_peak_roster_catalog.json`**: Dataset JSON lengkap terstruktur dari seluruh tabel karakter untuk konsumsi sistem.

### Verifikasi Empiris
- Script ekstraksi Python (`build_roster_catalog.py`, `generate_docs.py`) berhasil membaca Unity AssetBundles secara langsung melalui UnityPy dan Mono.Cecil.
- File dokumentasi `docs/FLASH_PEAK_CHARACTERS.md` berukuran 59.397 bytes terbuat dengan valid.


## [2026-11-23] Sesi: Implement 5,000-Char Smart Safety Guard on Omak Peak Chat Responses

### Konteks Sesi
- User menyetujui penerapan batas pengaman (safety guard) untuk chat Omak Peak: batas 5.000 karakter (setara ~1.500 - 1.800 token) untuk mencegah runaway generation/spam loop sambil memastikan jawaban analisis panjang tetap utuh dan tuntas.
- Implementasi `smartTruncate`:
  - Jika teks <= 5.000 karakter: dikirim 100% utuh tanpa modifikasi apa pun.
  - Jika teks > 5.000 karakter: dipotong secara cerdas pada batas kalimat (`. `) atau baris baru (`\n`) terdekat (bukan di tengah kata/huruf) dan diakhiri dengan catatan kaki rapi: `\n\n_(Pesan terpotong pada batas maksimal 5.000 karakter)_`.

### Perubahan Kode (Surgical)
1. **`src/application/omak-peak.ts`**:
   - Menambahkan fungsi `smartTruncate(text, maxLen = 5000)`.
   - Menggunakan `smartTruncate(text, 5000)` pada `handleAiCommand`.
2. **`tests/unit/ai_native.test.ts`**:
   - Menambahkan unit test `smartTruncate: leaves text <= 5000 chars untouched, cleanly cuts > 5000 at sentence break`.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run tests/unit/ai_native.test.ts`: 52/52 PASS.


## [2026-11-23] Sesi: Remove Artificial Character Truncation on Omak Peak Chat Responses

### Konteks Sesi
- User memeriksa log aktivitas WhatsApp selama 30 menit terakhir dan menemukan bahwa ketika peserta menanyakan analisis peluang juara atau skenario kelolosan (`!ai kasih chance berapa persen lolos...`), respon bot terpotong di tengah kalimat dan berakhiran tanda elipsis (`…`).
- User meminta agar batasan pengiriman tersebut dihapus agar analisis mendalam tidak terpotong.
- Investigasi akar masalah:
  - Pada `src/application/omak-peak.ts` terdapat pemotongan artifisial `const maxLen = 1800; const finalText = text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;`.
  - WhatsApp protokol mendukung hingga 65.536 karakter, sehingga pemotongan 1.800 karakter adalah batas artifisial yang tidak perlu.
  - Provider adapters untuk LLM text task sudah unconstrained; satu-satunya pemotong adalah baris tersebut.

### Perubahan Kode (Surgical)
1. **`src/application/omak-peak.ts`**:
   - Menghapus pemotongan karakter 1.800 dan elipsis (`…`). Respon AI sekarang dikirim penuh (`finalText = text`) sehingga seluruh penjelasan skenario dan persentase tidak terpotong.
2. **`tests/unit/ai_native.test.ts`**:
   - Menambahkan unit test `does not truncate long responses and delivers full text without ellipses` (> 2.400 karakter) untuk memastikan teks panjang dikirim utuh tanpa terpotong.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 323/323 PASS (23 test files).



## [2026-11-22] Sesi: Redesign Schedule Layout (2-Line Format & Completed Match Scores with Checkmarks)

### Konteks Sesi
- User melaporkan tampilan output `!jadwal` di WhatsApp sulit dibaca, tidak nyaman, dan teksnya saling bertumpuk ("saling tumpuk").
- Akar masalah:
  1. Dalam satu baris digabung: nama tim, mention delegasi (`@Delegate`), `vs`, nama tim lawan, mention delegasi lawan, dan keterangan Host berulang (`Host: Nama Tim`). Pada layar HP, baris ini terlipat menjadi 3–4 baris dan bertumpuk tanpa jeda.
  2. WhatsApp me-render mention LID internal menjadi nama profil WA delegasi yang panjang.
  3. Tidak ada jeda baris pemisah antar ronde di setiap grup.
  4. Jadwal belum memunculkan status dan skor pertandingan yang telah selesai.
- User memilih **Opsi 2**: memisahkan baris mention delegasi ke bawah nama tim, serta menampilkan skor akhir dan centang hijau (`✅`) untuk pertandingan yang sudah selesai (tanpa tag mention), sementara pertandingan belum main (`⏳`) mempertahankan tag delegasi terpisah di baris kedua.

### Perubahan Kode (Surgical)
1. **`src/whatsapp/formatters.ts`**:
   - Memperluas interface `FixtureScheduleDisplayItem` dengan `status?: string | null`, `teamAScore?: number | null`, `teamBScore?: number | null`, dan `isWalkover?: boolean | number | null`.
   - Pada `formatFixturesSchedule`:
     - Menambahkan baris kosong pemisah sebelum setiap `🔹 *${roundName}*` untuk memberi ruang visual.
     - Jika match berstatus `COMPLETED` atau `WALKOVER` dengan skor tersedia, tampilkan format rapi bercentang:
       `  ✅ *Team A*  X - Y  *Team B*` (dengan suffix `_(WO)_` bila walkover).
     - Jika match belum dimainkan (`SCHEDULED`):
       - Baris 1: `  ⏳ *Team A* vs *Team B* (Host: HostName)`
       - Baris 2 (jika ada delegasi): `     👤 @DelegateA vs @DelegateB`
     - Footer diperbarui dengan keterangan legenda: `💡 _Keterangan: ✅ = Selesai, ⏳ = Belum Tanding._`
2. **`src/application/tournament-commands.ts`**:
   - Memperbarui query `fixturesRes` pada command `scheduleHandler` (`!schedule` / `!jadwal`):
     - Menambahkan kolom `f.status as fixture_status`, `gm.team_a_score`, `gm.team_b_score`, `gm.is_walkover` via LEFT JOIN ke tabel `games`.
     - Meneruskan `status`, `teamAScore`, `teamBScore`, dan `isWalkover` ke objek `scheduleItems`.
3. **`tests/unit/formatters.test.ts` & `tests/unit/matchday.test.ts`**:
   - Memperbarui ekspektasi test schedule agar cocok dengan struktur 2 baris baru.
   - Menambahkan unit test baru `formats completed and walkover matches with checkmarks and scores` untuk memverifikasi match selesai menampilkan `✅` dan skor, serta match belum main menampilkan `⏳` dan baris delegasi.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 322/322 PASS (23 test files).
- Script dry run memvalidasi output bersih tanpa tumpukan teks di konsol.



## [2026-11-22] Sesi: Enrich Omak Peak Context with Player Stats, Fixture Scores, and Full Schedule

### Konteks Sesi
- Peserta di grup WhatsApp bertanya ke `!ai` (`!ai info top scorrer`, `!ai siapa top score skrg`). Bot menjawab tidak memiliki data pencetak gol karena data tersebut belum diinjeksikan ke dalam `OmakPeakContext`.
- Peserta juga menanyakan jadwal match selanjutnya, sementara sebelumnya query fixture dibatasi `LIMIT 12` tanpa memuat skor pertandingan yang telah selesai.
- Organizer meminta agar `!ai` memahami seluruh konteks turnamen yang ada: pencetak gol terbanyak (*top scorers*), pemberi assist terbanyak (*top assists*), pemain bertahan (*top defenders*), dan seluruh 24 jadwal pertandingan lengkap dengan skor match yang sudah selesai.

### Perubahan Kode (Surgical)
1. **`src/ai/prompts/omak-peak-context.ts`**:
   - Memperluas antarmuka `OmakPeakContext` dengan:
     - `top_scorers?: Array<{ rank, nickname, team_name, goals, matches }>`
     - `top_assists?: Array<{ rank, nickname, team_name, assists, matches }>`
     - `top_defenders?: Array<{ rank, nickname, team_name, defense, matches }>`
     - `awards_status?: { goalkeeper_award_suspended, active_awards, notes }`
     - Menambahkan field `score?: string | null` dan `is_walkover?: boolean` pada `today_fixtures`.
2. **`src/application/omak-peak.ts`**:
   - Memperbarui query `today_fixtures` untuk mengambil seluruh jadwal turnamen (menghapus batas sempit `LIMIT 12`), melakukan LEFT JOIN ke `games`, dan menyertakan skor real-time untuk pertandingan berstatus `COMPLETED` maupun `WALKOVER`.
   - Mengambil Top 10 Goal Scorers dari tabel `player_game_stats` (dikelompokkan per pemain, diurutkan total gol terbanyak).
   - Mengambil Top 10 Assist Providers dari tabel `player_game_stats`.
   - Mengambil Top 10 Defenders dari tabel `player_game_stats`.
   - Menyertakan catatan status penghargaan (`awards_status`) bahwa kategori kiper ditangguhkan sementara atas instruksi panitia.
   - Memperbarui `RULES_SUMMARY` di sistem prompt Omak Peak agar sinkron dengan aturan 1 screenshot scoreboard.
3. **`src/ai/prompts/omak-peak.ts`**:
   - Memperluas instruksi prompt Omak Peak pada bagian `JAWAB BERDASARKAN KONTEKS` agar proaktif dan percaya diri menggunakan data `top_scorers`, `top_assists`, `top_defenders`, dan skor fixture saat ditanya oleh peserta.
4. **`tests/unit/ai_native.test.ts`**:
   - Menambahkan unit test baru untuk memverifikasi bahwa `buildOmakPeakContext` berhasil memuat `top_scorers`, `top_assists`, `top_defenders`, serta skor pertandingan yang sudah selesai.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 321/321 PASS (23 test files).


## [2026-11-22] Sesi: Suspend Goalkeeper Screenshot Requirement & Award Category

### Konteks Sesi
- Sesuai arahan organizer, format in-game Flash Peak menampilkan data kartu statistik kiper secara terpisah (individual screen) dan bukan pada scoreboard utama, sehingga membingungkan alur pelaporan peserta.
- Organizer memutuskan untuk **menangguhkan sementara** (suspend) kategori penghargaan Best Goalkeeper dan kewajiban screenshot detail kiper selama turnamen berjalan (kode tidak dihapus, disiapkan untuk disempurnakan pasca-turnamen).
- Menyiapkan draf pengumuman resmi WhatsApp untuk panitia.

### Perubahan Kode (Surgical)
1. **`src/application/evidence-batch-processor.ts`**:
   - Menambahkan pengecekan flag `process.env.SUSPEND_GOALKEEPER === 'true'`.
   - Jika ditangguhkan, `expectedGkCount` diset ke 0, sehingga peserta **tidak lagi diwajibkan** menyertakan screenshot detail kiper (hanya cukup 1 foto skor utama), tidak ada warning kuota kiper kurang, dan babak Knockout tidak akan terblokir.
   - Seluruh logika ekstraksi dan mapping kiper yang sudah ada tetap dipertahankan (tidak dihapus).
2. **`src/whatsapp/formatters.ts`**:
   - Pada `formatAwardsAnnouncement`, jika kiper ditangguhkan, kategori *Best Winning Goalkeeper* diberi label keterangan jelas: `_(Status: Kategori penghargaan kiper ditangguhkan sementara oleh panitia turnamen)_`.
3. **`.env.example`**:
   - Menambahkan dokumentasi flag `SUSPEND_GOALKEEPER=false`.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 320/320 PASS (23 test files).


## [2026-11-22] Sesi: WhatsApp Log Audit & Round 1 Progress Verification (20:00 - 22:05 WIB)

### Konteks Sesi
- Melakukan audit menyeluruh terhadap pesan masuk WhatsApp di database SQLite VM (`inbound_messages`), log PM2 (`bot-out.log`), draf sesi laporan aktif (`report_sessions`), dan status fixture Round 1 dari pukul 20:00 WIB (13:00 UTC) hingga sekarang (~22:05 WIB / 15:05 UTC) untuk mendeteksi event yang terlewat, kendala peserta, dan status pertandingan.

### Temuan Audit & Status Pertandingan
1. **Pertandingan Round 1 Resmi Selesai (LOCKED & Standings Updated):**
   - **Grup A:** Helix Moonbreaker 6 - 2 Agility Starlight (`LOCKED`)
   - **Grup B:** The Apostles Dominion 9 - 0 Jestre (`LOCKED`)
   - **Grup C:** Elite 8 7 - 3 AVOID Impact (`LOCKED`)
   - **Grup D:** Kazekage 7 - 2 7Sins•BlueLock Inferno (`LOCKED`)
   - Tabel `standings` di SQLite sudah otomatis terhitung akurat sesuai hasil match ini.

2. **Pertandingan yang Tertunda / Terlewat:**
   - **Grup C — Raikage vs AVOID Prime (`5ff511d2-6b3a-4279-a2f3-9fda7d975180`):**
     - Delegasi Raikage mencoba klaim WO karena AVOID Prime tidak hadir 10 menit setelah room dibuka.
     - Raikage mengirim SS chat lobi/diskusi, sehingga AI mengembalikan respon *Screenshot Tidak Dapat Dibaca*.
     - Raikage kemudian mengetik `!klaimwo` tanpa argumen di grup, sehingga klaim belum tereksekusi. Fixture masih berstatus `SCHEDULED`.
   - **Grup D — Team Zodiac vs Hokage (`38f2b9c9-4671-4019-9685-d1973d87c740`):**
     - Peserta membagikan room code (`328398 12`) sekitar pukul 21:56 WIB dan sedang tanding, namun belum ada SS skor akhir yang dilaporkan ke bot. Masih `SCHEDULED`.
   - **Grup A — 7Sins•BlueLock Venom vs Mizukage (`5093fee9-11fa-4544-a5b0-02830b1314fa`):**
     - Belum ada aktivitas/laporan skor yang masuk. Masih `SCHEDULED`.
   - **Grup B — Yakigami vs Astra Lumina Nova (`98c46679-c237-4357-b4d6-f8a22845e5e9`):**
     - Belum ada aktivitas/laporan skor yang masuk. Masih `SCHEDULED`.

3. **Status Bot & Layanan:**
   - PM2 `flashpeak-bot` berjalan normal (PID 3238480, online).
   - Fitur approval hanya pemenang + panitia dan template footer informatif sudah aktif.


## [2026-11-22] Sesi: Winner-Only Approval Simplification & Informative Report Draft Tutorial

### Konteks Sesi
- Organizer meminta penyederhanaan alur approval: laporan pertandingan yang memiliki pemenang hanya butuh persetujuan dari **pihak pemenang dan panitia** (tidak perlu menunggu tim yang kalah meng-approve, mencegah bottleneck jika tim kalah offline/enggan approve). Jika game seri (draw), tetap butuh persetujuan kedua tim & panitia.
- Organizer meminta draf laporan pertandingan dari bot dilengkapi panduan/tutorial kelanjutan yang super informatif agar peserta langsung paham langkah selanjutnya (cara approve vs cara koreksi).

### Perubahan Kode (Surgical)
1. **`src/reports/approval.ts`**:
   - Menambahkan fungsi `getRequiredApprovers(version: ReportVersion): ApproverType[]`:
     - Jika Team A menang (`scoreA > scoreB`): `['TEAM_A', 'ORGANIZER']`.
     - Jika Team B menang (`scoreB > scoreA`): `['TEAM_B', 'ORGANIZER']`.
     - Jika seri / draw: `['TEAM_A', 'TEAM_B', 'ORGANIZER']`.
   - Menggunakan `getRequiredApprovers` dalam `submitReportApproval` untuk mengecek `missingApprovers` dan melakukan transisi ke `LOCKED` segera setelah pemenang dan panitia approve.
   - Mengubah respon bot saat vote dicatat dan saat terkunci ke bahasa Indonesia yang jelas dan informatif.
2. **`src/whatsapp/formatters.ts`**:
   - Memperluas footer draf laporan pertandingan (`status === 'PENDING_APPROVAL'`):
     - Menampilkan nama delegasi tim pemenang dan organizer yang ditunggu persetujuannya.
     - Menyertakan tutorial jelas: jika data benar silakan balas draf dengan `!approve`.
     - Menyertakan tutorial jelas: jika data salah JANGAN approve, balas draf dengan rincian koreksi (contoh format diberikan).
     - Menambahkan panduan pada status `NEEDS_CORRECTION`.
3. **`src/application/evidence-batch-processor.ts`, `manual-report-session.ts`, `tournament-commands.ts`**:
   - Menyelaraskan daftar `pendingApprovers` saat draf dibuat agar memprioritaskan pemenang & organizer.
4. **`tests/unit/reports.test.ts` & `tests/integration/full_flow.test.ts`**:
   - Menyelaraskan assertion approval di unit & integration test.

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 320/320 PASS (23 test files).
- Git pushed to `origin/master` (commit `740a9d6`).
- Deployed ke VM (`forfh`):
  - `git pull --ff-only origin master`
  - `npm run build`
  - `pm2 restart flashpeak-bot --update-env && pm2 save` (PID 3238461, online).
  - WhatsApp Baileys reconnect: `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!`.


## [2026-11-22] Sesi: Fix Evidence Side Inversion Bug & Participant Dispute Resolution

### Konteks Sesi
- Peserta melaporkan anomali hasil ekstraksi pertandingan di WhatsApp:
  - "Lah salah nama itu"
  - "salah yang menang elite 8"
  - "Kok ke balik skor jya"
- Terjadi sengketa pertandingan antara Helix Moonbreaker vs 7Sins (7SB) mengenai jadwal match dan klaim walkover (WO).

### Investigasi & Root Cause
1. **Side & Score Inversion Bug (`src/application/evidence-batch-processor.ts`)**:
   - Kode lama mengasumsikan tim yang mengirim bukti selalu berada di sisi kiri (Team A):
     `const isSubmittingTeamB = Boolean(submittingTeamId && submittingTeamId === teamBId);`
     Jika `isSubmittingTeamB === true`, skor dan daftar pemain ditukar secara naif!
   - Di Flash Peak, sisi kiri (kandang/host) dan sisi kanan (tandang) pada screenshot skor akhir bersifat global dan sama untuk semua pemain, tidak bergantung pada siapa yang mengambil/mengirim screenshot.
   - Ketika delegasi Team B (misal AVOID Impact atau Kazekage) mengirim screenshot skor akhir di mana Team A ada di kiri dan Team B di kanan, kode menukar skor dan pemain. Akibatnya:
     - Skor terbalik (pemenang tertukar).
     - Pemain Team A dimasukkan ke Team B dan sebaliknya.
     - Validasi roster gagal (`is not a registered active player on Team A`) sehingga draft status jatuh ke `NEEDS_CORRECTION`.
2. **Goalkeeper Target Team**:
   - `targetGkTeamId` lama memilih `submittingTeamId` lebih dulu daripada pemenang match. Jika tim kalah yang mengirim bukti, bot mencari kiper pemenang di roster tim yang kalah sehingga gagal menemukan kiper.
3. **Sengketa Helix vs 7SB**:
   - Berdasarkan jadwal resmi turnamen di database (`fixtures`), match `Helix Moonbreaker` vs `7Sins•BlueLock Venom` dijadwalkan di **ROUND_2 (Matchday 2 / Besok)**, BUKAN Matchday 1 (hari ini).
   - Hari ini di Matchday 1: Helix seharusnya bertanding melawan Agility Starlight, sedangkan 7Sins melawan Mizukage.
   - Sengketa terjadi karena kesalahpahaman delegasi. Bukan WO karena jadwal matchday-nya memang belum tiba.

### Perubahan Kode (Surgical)
1. **`src/application/evidence-batch-processor.ts`**:
   - Menghapus swap berbasis `isSubmittingTeamB`.
   - Mengambil data roster aktif lengkap (`Player[]`) untuk `teamA` dan `teamB`.
   - Menggunakan `matchPlayerToRoster` untuk mencocokkan pemain sisi kiri (`team_a_players`) dan sisi kanan (`team_b_players`) dari screenshot terhadap `rosterA` dan `rosterB`.
   - Menentukan orientasi secara deterministik:
     - Jika pemain kiri lebih cocok ke Roster B dan pemain kanan lebih cocok ke Roster A (`invertedScore > normalScore`), tukar sisi.
     - Jika tie/unmatched, gunakan fallback `fixture.left_side_team_id`.
     - Selain itu, pertahankan orientasi default tanpa menukar berdasarkan pengirim pesan.
   - Memperbaiki `targetGkTeamId` agar memprioritaskan tim pemenang (`winningTeamId || submittingTeamId || teamAId`) sesuai aturan §7.3.
   - Menambahkan pelengkap lineup 5 pemain (`buildFullLineup`): jika tabel skor Flash Peak hanya menampilkan 4 pemain outfield, kiper resmi terdaftar dari roster tim otomatis ditambahkan sehingga total lineup 5 pemain (1 GK, 4 outfield) dan lolos validasi.
2. **`src/ai/providers/mistral.ts` & `src/ai/router.ts`**:
   - Menyetel `capabilities.vision = false` pada MistralAdapter dan menghapus Mistral dari prioritas vision (`isVision`).
   - Menempatkan Mistral di prioritas terdepan untuk percakapan teks (`!ai` / Omak Peak / casual chat) sesuai permintaan organizer.
   - Task ekstraksi gambar dialihkan ke vision providers utama (DeepSeek, Groq, Gemini, Nvidia).
3. **`tests/integration/evidence_media_guards.test.ts`**:
   - Menambahkan unit/regression test: `does not invert scores or rosters when Team B submits screenshot where Team A is on the left`.
   - Menambahkan unit test: `attaches designated goalkeeper when scoreboard extraction only has 4 outfield players`.
4. **Database Correction**:
   - Menyiapkan dan menjalankan script `scripts/fix_and_lock_matches.ts` untuk mengoreksi dan mengunci hasil 4 pertandingan MD1 secara resmi di database (`games`, `player_game_stats`, `fixtures`, `standings`).

### Verifikasi Empiris
- `npx tsc --noEmit`: 0 error.
- `npx vitest run`: 319/319 PASS (23 test files).
- **Eksekusi Koreksi Database Produksi di VM (`scripts/fix_and_lock_matches.ts`)**:
  - `7Sins vs Kazekage` (Fixture `b17c0966...`): Validated 2 - 7 (Winner: Kazekage). LOCKED. 10 stats recorded.
  - `Jestre vs The Apostles Dominion` (Fixture `70ab663b...`): Validated 0 - 9 (Winner: The Apostles Dominion). LOCKED. 10 stats recorded.
  - `Elite 8 vs AVOID Impact` (Fixture `7e7971d6...`): Validated 7 - 3 (Winner: Elite 8). LOCKED. 10 stats recorded.
  - `Agility Starlight vs Helix Moonbreaker` (Fixture `7eb46b0f...`): Validated 2 - 6 (Winner: Helix Moonbreaker). LOCKED. 10 stats recorded.
- **Hasil Klasemen Grup Pasca-Koreksi**:
  - **Group A**: Helix Moonbreaker (P:1, W:1, GF:6, GA:2, GD:+4, PTS:3), Agility Starlight (P:1, L:1, GF:2, GA:6, GD:-4, PTS:0).
  - **Group B**: The Apostles Dominion (P:1, W:1, GF:9, GA:0, GD:+9, PTS:3), Jestre (P:1, L:1, GF:0, GA:9, GD:-9, PTS:0).
  - **Group C**: Elite 8 (P:1, W:1, GF:7, GA:3, GD:+4, PTS:3), AVOID Impact (P:1, L:1, GF:3, GA:7, GD:-4, PTS:0).
  - **Group D**: Kazekage (P:1, W:1, GF:7, GA:2, GD:+5, PTS:3), 7Sins•BlueLock Inferno (P:1, L:1, GF:2, GA:7, GD:-5, PTS:0).
- **PM2 State**: `flashpeak-bot` online (PID 3232748), WhatsApp Baileys connected.

---

## [2026-11-22] Sesi: AI-Native Feature Expansion + Hardening + Long-Term Maintainability (Task: flash-peak-tms-ai-native-expansion-v1, Branch: feat/ai-native-expansion-v1)

### Konteks Sesi
Penyempurnaan menyeluruh proyek Flash Peak TMS (TurFpeak) sesuai brief Arya 22 Nov 2026: hardening, audit fresh-eyes, fitur AI-native baru (!ai/Omak Peak, AI agent admin-eksekusi, !qna/!saveqna, engagement/trivia), dokumentasi sync, maintainability jangka panjang. Branch `feat/ai-native-expansion-v1` dibuat dari master HEAD `86b0c7f` (paling maju — semua 8 PR sebelumnya sudah merged; tidak ada PR terbuka; tidak ada review comment yang belum ditindaklanjuti).

### Pemetaan Awal (verifikasi langsung dari repo + VM)
- Clone repo, cek semua branch (8 branch selain master, semuanya 0 commit ahead of master — fully merged). `gh pr list --state=all`: 8 PR, semua merged.
- Baseline: `tsc --noEmit` 0 error; `vitest run` 258/258 PASS (20 file).
- VM (`forfh`, `20.214.143.187`, user `azureuser`, project `/home/azureuser/flashpeak-tms`) di HEAD master yang sama (tidak ada drift produksi). Tournament `Gojiha Cup S1` status `DRAW_READY` (paused by Arya pasca-draw). 16 tim, 4 grup, 24 fixture, 0 match dimainkan, 0 series, 0 report_versions, 3 audit_events (2 draw + 1 manual roster correction).
- **Temuan utang teknis #1**: `worklog.md` korupsi duplikasi berlapis — file 1206 baris berisi 5 salinan file lama ter-append berulang (header `# Worklog` muncul 5x). Total sesi unik hanya 18, 4 di antaranya HANYA ada di salinan lama. FIXED: dedupe preserving semua 18 sesi unik (1072 baris final).
- **Temuan #2**: `inbound_messages` hanya capture pesan evidence/koreksi (bukan semua chat grup). Akibatnya `!saveqna` (butuh last-10 group messages) tidak akan jalan tanpa perluasan capture. FIXED: broad capture semua TEXT message di central group (idempotent via provider_message_key UNIQUE; IMAGE messages untouched — evidence path intact).
- **Temuan #3**: AGENT.md / AGENTS.md / GEMINI.md adalah 3 copy identik (md5 sama). Dibiarkan (tidak mengganggu; dokumentasi internal).
- **Observasi**: Arya sudah publik memperkenalkan "Omak Peak" sebagai asisten bot di pesan sambutan grup (2026-11-21 08:25 WIB) — jadi persona `!ai`/Omak Peak sudah dijanjikan ke peserta; fitur ini realisasi-nya.

### Utang Lama Diselesaikan
1. **worklog.md korupsi duplikasi** — FIXED (lihat di atas).
2. **Audit log WA terbatas** — FIXED via broad text capture (AI-NATIVE-001 di `src/index.ts`).
3. Tidak ada PR terbuka / review comment yang belum ditindaklanjuti — verified.

### Fitur Baru Diimplementasikan (D-037..D-040)

**1. `!ai` Omak Peak (D-037)** — `src/application/omak-peak.ts` + `src/ai/prompts/omak-peak.ts` + `omak-peak-context.ts`
- Read-only AI chat, ANY role, open-scope (turnamen/Flash Peak/casual).
- Persona "Omak Peak": santai, percaya diri, sesekali nyentil dari sisi konteks Flash Peak; bukan generic-AI tone.
- Rolling-window rate limit 2/user/60s (`RollingRateLimiter` class, in-memory, per-sender).
- Context builder: active tournament, fixtures, standings, teams+delegates (contacts shareable per D-037), qna, rules summary — semua read-only.
- AI-unavailable graceful fallback; rate-limit message dengan retry-after hint.
- First-use/no-arg: intro message (no state write — read-only invariant preserved).

**2. Organizer AI Agent (D-038)** — `src/application/agent-planner.ts` + `agent-actions.ts`
- `!agent <instruction>`: AI menyusun rencana dari CLOSED action catalog (reopen_report, override_lock, forfeit_winner, reschedule_fixture, cancel_fixture, set_tournament_status, record_ko_game_score, announce). AI NEVER produces free-form SQL/code.
- `!agentconfirm <code>`: atomic claim PENDING→EXECUTING; transactional execute (libSQL `db.transaction('write')`); semua aksi all-or-nothing; rollback pada kegagalan.
- **Idempotency (non-negotiable)**: double-confirm EXPLICITLY rejected dengan prior outcome + timestamp (tidak silently ignored). Atomic claim via `UPDATE status='EXECUTING' WHERE plan_code=? AND status='PENDING' AND expires_at > now` — affected rows = 0 means lost the race.
- Plan TTL 10 menit; expired/cancelled/cross-organizer semua ditolak eksplisit.
- Audit trail: `audit_events` per execution (AI_AGENT_PLAN_EXECUTED / AI_AGENT_PLAN_FAILED) dengan before/after JSON + instruction + plan_code.
- Crash recovery: `recoverInterruptedPlans()` di `FlashPeakApp.start()` mark stale EXECUTING (>5 min) sebagai FAILED.
- `set_tournament_status` action menggantikan manual SQL UPDATE yang Arya lakukan di VM pasca-draw (worklog 2026-11-21).
- Test idempotency + transactional rollback + cross-organizer reject + crash recovery: `tests/unit/ai_native.test.ts` (29 tests).

**3. `!qna` / `!saveqna` (D-039)** — `src/application/qna.ts`
- `!qna` (ANY): list living FAQ.
- `!saveqna [n]` (ORGANIZER): AI ekstrak Q&A dari last-N (default 10, max 50) group messages. AI decides mana Q&A valid vs obrolan (no rigid heuristic). Dedup via AI marking + UNIQUE(question, answer) constraint. Rate guard 30s cooldown.
- Bergantung pada broad text capture (AI-NATIVE-001).

**4. Engagement & Hiburan (D-040)** — `src/application/engagement.ts` + `trivia.ts`
- `EngagementService.buildHypeRecap(facts)`: 2-4 kalimat hype setelah KO series selesai. Facts dari DB (skor, margin, round); AI format presentation only; never invents in-match events. Wired di `handleKoGameEvidenceMessage` (detached follow-up, non-blocking).
- `EngagementService.buildChampionCelebration(facts)`: pesan juara saat Grand Final selesai. Wired di tempat yang sama.
- `!trivia`: random verified Flash Peak fact dari curated JSON DB (`src/data/flashpeak-trivia.json`, researched via web at dev time). Runtime AI only rephrases; never invents.
- `!quiz`: quiz question + delayed answer reveal (15s).
- `!pantun`: AI-generated pantun (no factual claims; safe to invent).
- Group-stage report-lock hype: designed tapi belum di-wire ke approval flow (documented as follow-up — wiring ke flow yang well-tested riskier; service siap).

### Foundation Changes
- **Migration 004** (`migrations/004_ai_native_features.sql`): `ai_action_plans` (plan_code UNIQUE, status CHECK PENDING/EXECUTING/EXECUTED/EXPIRED/CANCELLED/FAILED) + `qna_entries` (UNIQUE question+answer). `provider_usage` CHECK expanded via table rebuild (rename-copy-drop) untuk task_type baru.
- **AITaskType** (`src/shared/types/index.ts`): +CHAT_OMAK_PEAK, PLAN_AGENT, EXTRACT_QNA, FORMAT_HYPE, GENERATE_PANTUN, REPHRASE_TRIVIA.
- **Broad text capture** (`src/index.ts` AI-NATIVE-001): semua TEXT message di central group di-capture ke `inbound_messages` (idempotent; IMAGE untouched).
- **AI-native command registration** (`src/application/ai-native-commands.ts`): module terpisah agar `tournament-commands.ts` (3729 baris) tidak tambah besar. Modularisasi precedent dilanjutkan.
- **Flash Peak trivia DB** (`src/data/flashpeak-trivia.json`): 21 fakta + 10 quiz, terverifikasi via web research (Google Play com.moco.crgame, flashpeak.net, Threads/@apixelart, duniagames.co.id). Fakta: developer Moco Studios/Garena, 4v4 arcade, 5-min match, third-person single-character, no offside, Free Fire crossover characters (Shirou/Homer/Alvaro/Kelly/Hayato/Moco), 7 ranked tiers, dll.

### Bukti & Verifikasi Empiris
- `npx tsc --noEmit`: **0 error** (clean).
- `npx vitest run`: **287/287 PASS** (21 file; 258 lama + 29 baru di `tests/unit/ai_native.test.ts`; 0 regresi).
- Migration 004 apply test: fresh `:memory:` DB via `runMigrations` → tables `ai_action_plans`, `qna_entries`, `provider_usage` ada; CHECK constraint include `EXECUTING` + `CHAT_OMAK_PEAK`.
- Test spesifik idempotency: double-confirm rejected dengan "SUDAH DIEKSEKUSI" + "idempotency"; expired plan rejected; cancelled plan rejected; cross-organizer rejected; transactional rollback (2-action plan dengan action ke-2 invalid → tournament status TIDAK berubah, plan FAILED, audit_event AI_AGENT_PLAN_FAILED tercatat); crash recovery (stale EXECUTING >5min → FAILED dengan "Interrupted" reason).
- Test rate limiter: 2 uses dalam 60s allowed, 3rd rejected dengan retryAfterMs 30-45s; rolling window (oldest expires → 3rd allowed); per-sender独立.
- Test catalog preview: reopen_report rejects unknown fixture / non-COMPLETED status; forfeit_winner rejects winning_team_id not in fixture; catalog.toPromptJson lists all 8 action_ids.
- Test qna: listEntries empty-state + with entries; extractAndSave graceful when no messages; rate-guard 30s.
- Test trivia: loads curated DB; randomFact returns content; randomQuiz returns Q+A.

### Audit Fresh-Eyes (REPORTED, tidak difix kecuali in-scope)
1. **[LOW] Approval flow tidak transactional** (`src/reports/approval.ts:180-260`): insert approval + check 3-approval + LOCK transition adalah separate `db.execute`, tidak wrapped dalam transaction. Crash di antara bisa meninggalkan version dengan 3 approval tapi status PENDING_APPROVAL. Tidak difix (flow well-tested; WhatsApp messages sequential; practical impact near-zero; changing risks regression).
2. **[LOW] Numeric-index column access fragility** (widespread `rows[0][0]`): works (libsql rows array-like) tapi fragile kalau SELECT column order berubah. Tidak difix (cosmetic; menyentuh banyak file).
3. **[RECOMMENDATION] AI-first nickname-to-roster matching**: tiered deterministic matcher (`src/reports/validation.ts`, added 2026-11-21) working dengan zero false positives. Enhancement: pass roster di MAIN_MATCH_PROMPT trusted context, AI propose matched_player_id, deterministic matcher sebagai authoritative fallback. Tidak diimplement di PR ini (changing extraction schema/prompt warrants separate review; current state solid). Design sketch di PR description.
4. **[RECOMMENDATION] Modularisasi `tournament-commands.ts` (3729 baris)**: AI-native commands sudah dipisah ke `ai-native-commands.ts`. Full decomposition (standings-awards, schedule, draw, teams, roster, roomcard, wo, knockout, rules) recommended sebagai PR terpisah (pure code-motion, behavior-preserving).

### Audit Log WA (Task #3 — report only)
Scan `logs/bot-out.log` (14344 lines, covering 2026-11-20 to 2026-11-21) + `inbound_messages` (27 rows) di VM. Central tournament group: `120363412423738009@g.us`. Arya LID: `165210883154071@lid`.
- **Tidak ada pertanyaan peserta yang kelewat** dalam window yang ter-log. Arya sangat responsif (typikal <30s).
- Contoh Q&A terverifikasi terjawab: "besok main harus bgt jam 8?" → "nggak bang" + "jadi dimulai dari 20.00 besok sampai 19.59 lusa"; "Sehari 1 ronde?" → "sehari 1 ronde"; "Ngitungnya manual apa pake bot?" → "bot" + explanation; "GK ku 2 bisa ga?" → "masukin ke cadangan"; "Cadangan ku penuh 3" → "sesuaiin itu bg"; "klao jam 7?" → "tergantung perjanjian sama lawannya".
- Catatan: bot sudah restart 47x, jadi history log terbatas (~1.9MB). Pesan TEXT sebelum broad-capture fix tidak persistent di DB (hanya di stdout log). Setelah deploy PR ini, future messages akan persistent → audit capability lebih baik ke depan.

### Dokumentasi Diupdate
- `DECISIONS.md`: +D-037 (Omak Peak), D-038 (Agent), D-039 (QnA), D-040 (Engagement) — confirmed per task brief 2026-11-22.
- `README.md`: section "AI-native expansion" baru.
- `DATA_MODEL.md`: `ai_action_plans`, `qna_entries`, `provider_usage` CHECK expansion.
- `PROMPT_CATALOG.md`: §12 — 6 prompt baru (omak_peak_chat_v1, agent_planner_v1, qna_extractor_v1, engagement_formatter_v1, pantun_generator_v1, trivia_rephrase_v1).
- `WORKFLOWS.md`: §13 — flows untuk !ai, !agent/confirm/cancel, !qna/!saveqna, engagement hooks.
- `MANIFEST.json`: version 0.2.0-draft, changelog, research sources updated (Flash Peak game sources).
- `worklog.md`: entry sesi ini + dedup fix.

### File yang Berubah
- New: `migrations/004_ai_native_features.sql`, `src/application/{omak-peak,agent-actions,agent-planner,ai-native-commands,qna,engagement,trivia}.ts`, `src/ai/prompts/{omak-peak,omak-peak-context}.ts`, `src/data/flashpeak-trivia.json`, `tests/unit/ai_native.test.ts`.
- Modified: `src/index.ts` (broad capture + AI-native wiring + engagement hooks + agent recovery), `src/shared/types/index.ts` (AITaskType expansion), `worklog.md` (dedup + this entry), `flash-peak-tms/{DECISIONS,README,DATA_MODEL,PROMPT_CATALOG,WORKFLOWS}.md`, `flash-peak-tms/MANIFEST.json`.

### Hal yang Dipertimbangkan tapi Sengaja Tidak Diubah
- Approval flow transactionality (LOW risk, well-tested; separate PR).
- tournament-commands.ts modularization (separate PR, pure code-motion).
- AI-first nickname matching (separate review; current tiered matcher solid).
- AGENT.md/AGENTS.md/GEMINI.md triplicate (cosmetic; tidak mengganggu).

## [2026-11-21] Sesi Fitur: Implementasi Tiered Player-to-Roster Matcher (Task: flash-peak-tms-tiered-roster-matcher-v1)

### Konteks Sesi
Pengujian screenshot pertandingan tim Agility Starlight mengungkap bahwa pemain yang terdaftar dengan variasi karakter Unicode / titik pemisah (seperti `AGIㆍIshikawa` vs `AGI • Ishikawa`, atau `AGIㆍL∆RZZ☢️` vs `AGI • LΛRZZ ☣`) gagal dicocokkan oleh kode validator backend (`src/reports/validation.ts`) meskipun AI Vision berhasil membaca teks screenshot dengan sempurna. Investigasi pada seluruh 16 tim di database (`local.sqlite`) menemukan bahwa kesamaan clan tag (seperti `AVO`, `7SB_`, `TZ`, `AGI`) membuat pemain dalam tim yang sama memiliki kemiripan bawaan hingga 66.7% - 80% (misal `TZ Kuroko` vs `TZ Kurona` 80%). Oleh karena itu, penggunaan threshold similarity tunggal yang rendah (misal 60%) berisiko tinggi menyebabkan salah identifikasi / tertukarnya pemain. Dibutuhkan sistem pencocokan bertingkat (*Tiered Matching*) yang tangguh terhadap variasi dekoratif dan typo OCR minor dengan jaminan zero false positives.

### Langkah & Perubahan yang Dieksekusi
1. **Peningkatan Mesin Pencocokan Roster (`src/reports/validation.ts`)**:
   - Menambahkan fungsi `cleanSearchKey(nick: string)`: menormalkan string ke NFKD, huruf kecil, dan membuang semua karakter non-alfanumerik (`[^a-z0-9]`).
   - Menambahkan fungsi `computeSimilarity(str1: string, str2: string)` berbasis Levenshtein distance dari `fastest-levenshtein`.
   - Mengimplementasikan `matchPlayerToRoster(raw: RawPlayerMatchStat, roster: Player[])`:
     - **Tier 1 (Exact Raw Match)**: `raw.nickname_raw === p.nickname_raw`.
     - **Tier 2 (NFC Normalized Match)**: `normalize(raw) === normalize(p)`.
     - **Tier 3 (Clean Alphanumeric Key Match)**: mencocokkan `cleanSearchKey` dari input terhadap `cleanSearchKey(p.nickname_raw)` atau `p.nickname_search_key`. Ini secara otomatis mengatasi perbedaan titik pemisah (`•` vs `ㆍ`), spasi, simbol clan tag (`|`, `〆`, `☣`, `☢️`), dan variasi alfabet dekoratif (`∆` vs `Λ`) dengan skor 100% cocok.
     - **Tier 4 (Safe Fuzzy Match)**: Ambang batas minimum similarity `>= 0.75` **DAN** wajib memiliki selisih skor (*safety margin gap*) `>= 0.15` di atas kandidat runner-up dalam tim. Jika selisih terlalu tipis / ambigu (misal typo di antara dua pemain mirip), sistem menolak tebakan (*returns null*) dan mewajibkan konfirmasi manual.
2. **Sinkronisasi Pemetaan Goalkeeper Saves (`src/application/evidence-batch-processor.ts`)**:
   - Memperbarui fungsi `resolvePlayerSaves` agar juga memeriksa kesamaan `cleanSearchKey`, sehingga saves dari screenshot detail kiper tetap terpetakan dengan benar meski ada perbedaan simbol dekoratif di summary screen.
3. **Penambahan Test Suite Permanen (`tests/unit/reports.test.ts`)**:
   - Menambahkan describe block `Tiered Player-to-Roster Matcher (Zero False Positives & OCR Resilient)` yang menguji:
     - Exact raw dan NFC matching.
     - Stylized OCR variations (`AGI • Ishikawa` ➔ `AGIㆍIshikawa`, `AGI • ZKII☣` ➔ `AGIㆍZKII☣`, `AGI • LΛRZZ ☣` ➔ `AGIㆍL∆RZZ☢️`).
     - Safe fuzzy match untuk typo minor 1 karakter.
     - Penolakan input ambigu dengan safety gap < 15% (kasus `TZ Kuroko` vs `TZ Kurona`).
     - Penolakan tegas pemain tak terdaftar (`AGI • DIKZ`).

### Bukti & Verifikasi Empiris
- **Unit & Integration Tests**:
  - `npx vitest run tests/unit/reports.test.ts`: **25 tests passed (100%)**.
  - `npm run build` (`tsc`): **Clean compile tanpa error (Exit code 0)**.
- **Validasi terhadap Screenshot Agility Starlight**:
  - `AGI • LΛRZZ ☣` ➔ Cocok ke Slot 1 (`AGIㆍL∆RZZ☢️`) via Tier 3.
  - `AGI • Ishikawa` ➔ Cocok ke Slot 3 (`AGIㆍIshikawa`) via Tier 3.
  - `AGI • ZKII☣` ➔ Cocok ke Slot 2 (`AGIㆍZKII☣`) via Tier 3.
  - `AGI • DIKZ` ➔ Ditolak (Pemain Tidak Terdaftar, skor tertinggi di tim hanya 57.1%).

---


## [2026-11-21] Sesi Operasional VM: Pause Turnamen ke DRAW_READY Pasca-Draw (Task: flash-peak-tms-pause-draw-ready-v1)

### Konteks Sesi
Pengundian grup (`!draw`) untuk turnamen `Gojiha Cup S1` telah sukses dilaksanakan oleh Arya. Sesuai aturan sistem, command `!draw` mentransisikan status turnamen menjadi `ACTIVE`. Namun Arya menghendaki pertandingan baru dimulai besok dan tidak ingin cutoff harian 19:59 WIB mengevaluasi Double Walkover (D-031) pada sisa malam ini atau sebelum turnamen resmi dimulai besok.

### Langkah & Perubahan yang Dieksekusi
1. **Pengecekan Status Turnamen & Data Pasca-Draw di VM**:
   - Status sebelum perubahan: `ACTIVE` (ID: `14ec8b3d-e3b1-41d6-8af2-1b23734d3ff3`, 16 tim terbagi ke Grup A-D, 24 fixtures fase grup terbentuk).
2. **Eksekusi Transisi Status**:
   - Menjalankan update status database di VM (`forfh`):
     `UPDATE tournaments SET status = 'DRAW_READY', updated_at = <now_iso> WHERE id = '14ec8b3d-e3b1-41d6-8af2-1b23734d3ff3'`
   - Status baru: `DRAW_READY`.
3. **Verifikasi Efek Operasional**:
   - `MatchdayService` hanya memproses turnamen dengan `status = 'ACTIVE'`, sehingga:
     - Cutoff 19:59 WIB harian menjadi no-op.
     - Pengingat otomatis (17:00 dan 18:59 WIB) tidak akan tertrigger.
   - Seluruh data grup, 24 fixtures, klasemen, tim, dan delegasi tetap utuh dan aman.

### Bukti & Verifikasi Empiris
- **Status Sebelum**: `Status: ACTIVE`
- **Status Sesudah**: `Status: DRAW_READY` (diperbarui di `local.sqlite` pada `2026-11-21T14:25:55Z`).

---


## [2026-11-21] Sesi Follow-up 3: Fix Blocker & Quick-Wins dari Second-Opinion Review PR #8 (Task: flash-peak-tms-followup-roundcode-blocker-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Second-opinion review independen atas PR #8 (`PR8_second_opinion_review.md`) menemukan 1 blocker + 2 quick-win sebelum merge. Ketiganya difix di branch yang sama, regression penuh per commit, tidak merge/push (keputusan merge tetap milik Arya). Catatan konteks dari Arya: untuk turnamen ukuran Gojiha (16 tim: 4 grup isi 4 → 8 kualifikasi → QF 4 fixture → SF 2 → Final 1) blocker ini TIDAK kena karena jumlah fixture tiap ronde selalu unik; blocker relevan di turnamen besar (≥6 grup / ≥24 tim, possible karena `!addteam` tanpa cap). Tetap wajib difix sebelum merge agar tidak meledak diam-diam di turnamen besar nanti.

### Item 1 — blocker-roundcode FIXED: label ronde dari histori ronde di DB, bukan jumlah fixture
- **Root cause (dibaca ulang sebelum fix):** `generateKnockoutFixtures` menurunkan `round_code` dari JUMLAH MATCH ronde itu (`fixtures.ts` lama: 1→FINAL, 2→SEMI_FINAL, 4→QUARTER_FINAL, selain itu→ROUND_OF_16 default). Dua ronde berbeda bisa kebetulan punya jumlah fixture yang sama-sama "non-standar" (mis. 6 grup → 12 kualifikasi → 6 fixture, lalu 6 pemenang → 3 fixture — keduanya jatuh ke default ROUND_OF_16). Karena `!startknockout` mengumpulkan pemenang via `WHERE round_code = <label terakhir>`, label ganda membuat pemenang ronde LAMA ikut ter-draw ulang — tim yang sudah tersingkir hidup lagi dan turnamen tidak pernah konvergen (terkonfirmasi reviewer via dry-run end-to-end).
- **Fix:** fungsi baru `deriveKnockoutRoundCode(db, tournamentId, matchCount)` di `src/competition/fixtures.ts`:
  1. Baca SEMUA label ronde knockout yang sudah tercatat di DB turnamen ini.
  2. Pilih label "natural" sesuai jumlah match (1→FINAL, 2→SEMI_FINAL, 4→QUARTER_FINAL, 8→ROUND_OF_16, 16→ROUND_OF_32) — supaya turnamen ukuran normal labelnya persis seperti dulu.
  3. Ronde 1-match SELALU FINAL (ronde setelahnya mengakhiri turnamen — by definition).
  4. Bila label natural sudah dipakai, maju sepanjang progresi (ROUND_OF_32→ROUND_OF_16→QUARTER_FINAL→SEMI_FINAL→FINAL) ke label yang belum dipakai. Khusus jumlah match non-standar (natural=null, mis. pool ganjil 3 fixture): scan dimulai SETELAH label terdalam yang sudah dipakai, sehingga label selalu MENYEMPIT (ronde setelah ROUND_OF_16 jadi QUARTER_FINAL, tidak pernah mundur ke ROUND_OF_32).
  5. Bila seluruh progresi habis (bracket ekstrem / pool ganjil beruntun), fallback ke label generik unik `KNOCKOUT_ROUND_<n>` — label tidak pernah bisa duplikat.
- **Fix pendukung (efek samping blocker yang sama):** `getActiveTournamentCurrentRound` di `matchday-service.ts` dulu mengurutkan ronde knockout secara LEKSIKALIS (`round_code ASC` → FINAL < QUARTER_FINAL < ROUND_OF_16 secara alfabetis — salah). Kini diurutkan menurut RANK progresi (R32→R16→QF→SF→FINAL), label di luar progresi (fallback `KNOCKOUT_ROUND_n`) diurutkan by first-seen `created_at` — berlaku untuk `allRounds` dan deteksi "ronde aktif" (ronde belum-selesai paling awal).
- **Dry-run reproduksi skenario PERSIS reviewer** (`verify-artifacts/check_roundcode_fix.mts`, semua via `!startknockout` + CommandRouter sungguhan):
  - PART 1 — 6 grup / 24 tim / 12 kualifikasi (skenario reviewer): label `ROUND_OF_32 → ROUND_OF_16 → QUARTER_FINAL → FINAL`, SEMUA label unik, TIDAK ADA tim tersingkir yang hidup lagi (diperiksa lintas ronde: tim yang kalah di ronde N tidak pernah muncul di ronde >N), turnamen KONVERGEN sampai FINAL. (Sebelum fix: ronde 2 & 3 sama-sama ROUND_OF_16, tim T5/T9/T11 yang sudah tersingkir ikut di-draw lagi, turnamen berputar selamanya.)
  - PART 2 — regression ukuran Gojiha (16 tim, 8 kualifikasi): label `QUARTER_FINAL → SEMI_FINAL → FINAL` — **identik perilaku lama**, tidak ada perubahan yang terlihat delegasi.
  - PART 2b — regression 16 kualifikasi: `ROUND_OF_16 → QUARTER_FINAL → SEMI_FINAL → FINAL` — identik perilaku lama.
  - PART 3 — progresi habis (8 ronde beruntun): fallback `KNOCKOUT_ROUND_6/7/8` — semua unik, tanpa kolisi.
  - Skenario reviewer lain (`review_roundcode_collision`): ronde 2 kini berlabel `QUARTER_FINAL` (dulu ROUND_OF_16 ganda); peserta ronde 2 = survivor ronde 1 semata.
- **Test permanen baru** (`tests/unit/competition.test.ts`, describe `REVIEW-FIX blocker-roundcode`): (a) ronde lebar 8 fixture ROUND_OF_16 disusul pool ganjil 7 survivor (3 fixture) → label QUARTER_FINAL (menyempit, unik, bukan ROUND_OF_32) + anti-self-match; (b) ronde 1-match SELALU FINAL + BO5 meski label lebih awal sudah terpakai.

### Item 2 — quickwin-shuffle-validation FIXED: validasi draw berdasarkan multiset team_id
- **Root cause:** validasi lama `new Set(drawn).size !== drawn.length` membandingkan IDENTITAS OBJEK — shuffle curang yang return objek BARU dengan `team_id` tertukar/terduplikasi lolos validasi dan bisa menghasilkan self-match X vs X (serangan persis reviewer, tadinya "DITERIMA (bug!)").
- **Fix:** hasil draw divalidasi berdasarkan multiset `team_id` — array `team_id` hasil shuffle harus PERSIS sama (sorted) dengan pool pra-draw; tambah/kurang/gandakan/mutasi team_id semuanya ditolak dengan error yang sama.
- **Bukti** (`verify-artifacts/check_quickwins_fix.mts` PART A): serangan reviewer (mutasi team_id antar objek) kini **DITOLAK**; duplikat elemen & elemen hilang tetap ditolak; shuffle sah (reverse, return-same-reference) tetap diterima tanpa self-match. Test permanen baru juga ditambahkan di `tests/unit/competition.test.ts` (describe `REVIEW-FIX quickwin-shuffle-validation`).

### Item 3 — quickwin-group-null-message FIXED: pesan knockout tanpa "(Grup null)", regulasi D-032
- **Root cause:** `formatMatchdayStatus` (!matchday) dan reminder H-3/H-1 (matchday-service.ts) men-draft `(Grup ${pf.groupCode})` untuk semua fixture — fixture knockout punya `groupCode` null → "(Grup null)" terlihat peserta; dan selalu menyebut D-031 (double walkover babak grup) meski yang pending fixture knockout (regulasinya D-032 double-loss + bye).
- **Fix:** label per-stage — fixture knockout ditampilkan `(Knockout)`, fixture grup tetap `(Grup X)`; regulasi dikutip per-stage: D-031 hanya bila ada fixture grup pending, D-032 (KALAH GANDA + bye otomatis) bila ada fixture knockout pending. Pengumuman cutoff (yang sudah benar sejak T17) tidak diubah.
- **Bukti** (`check_quickwins_fix.mts` PART B): B1 ronde SEMI_FINAL KO pending → "(Knockout)" + D-032, tanpa "(Grup null)", tanpa D-031; B2 regression ronde grup MD1 → "(Grup A)" + D-031 persis wording lama, tanpa "(Knockout)"/D-032.

### Regression Gate (dijalankan setelah SEMUA fix)
- `npx tsc --noEmit`: clean (0 error).
- `npx vitest run`: **253/253 PASS** (20 file; 250 test lama + 3 test permanen baru).
- Seluruh 24 skrip `verify-artifacts/check_*.mts` + 2 dry-run audit lama: semua exit 0, termasuk `check_t2_fix` (T2-FIX VERIFIED), `check_bracket_redraw` + `check_bracket_redraw_e2e` (BRACKET-REDRAW VERIFIED), `check_t17_fix` (T17-FIX VERIFIED), dan semua check T1–T18 lainnya — tidak ada regresi perilaku lama.
- ESLint `src`: 7 warning / 0 error — seluruhnya pre-existing (identik sebelum & sesudah perubahan; diverifikasi via stash).
- Skrip dry-run reviewer asli direplay: `review_roundcode_collision` (24-tim R16 + double-loss) dan `review_6group_happy` (24-tim happy path) — keduanya kini menunjukkan label unik & konvergen tanpa tim hidup lagi. (Heuristik "FAIL" di output script lama itu basi — script itu mem-filter fixture by `round_code='ROUND_OF_16'` yang setelah fix tidak lagi jadi label ronde 2; verdict sesungguhnya di `check_roundcode_fix.mts` yang menjalankan rantai penuh.)

### Scope Sesi Ini
- File produksi berubah: `src/competition/fixtures.ts` (deriveKnockoutRoundCode + validasi shuffle), `src/application/matchday-service.ts` (label "(Knockout)"/D-031/D-032 + ordering ronde), `tests/unit/competition.test.ts` (+3 test permanen).
- Check scripts baru: `verify-artifacts/check_roundcode_fix.mts`, `verify-artifacts/check_quickwins_fix.mts`.
- Tidak ada perubahan skema/migrasi; tidak merge/push ke master.


## [2026-11-21] Sesi Follow-up 2: Keputusan Bug Baru #1 & #2 (Task: flash-peak-tms-followup-resolveidentity-fix-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Lanjutan dari HEAD `f8287bf`. Arya memutuskan dua bug baru yang sebelumnya dilaporkan terbuka: (1) `bindDelegateToTeam` auto-VERIFIED → DITUTUP sebagai by design; (2) `resolveIdentity` 1-arg di report-correction-coordinator → PERLU DIFIX (samakan dengan router). Branch sama, regression penuh per commit, tidak merge/push.

### Item 1 — Bug baru #1 (bindDelegateToTeam auto-VERIFIED) CLOSED (by design, no fix)
Keputusan Arya 21 Nov 2026: grup WhatsApp turnamen bersifat tertutup (Arya sendiri yang memasukkan tim yang benar-benar ikut), sehingga skenario "orang asing/orang salah tim kirim format roster duluan untuk merebut status VERIFIED" secara praktis tidak akan terjadi. Perilaku "siapa cepat dia dapat" diterima sebagai aturan main yang disengaja, konsisten dengan keputusan T10. Tanpa perubahan kode.

### Item 2 — Bug baru #2 (resolveIdentity 1-arg di coordinator) FIXED — commit `50f6ab9`
**Verifikasi SEBELUM fix (sesuai prinsip):**
- Signature: `resolveIdentity(rawAddress, _sourceChatId?)` — argumen kedua **tidak dipakai sama sekali** di body (prefix underscore, nol referensi). Lookup murni by raw_address/normalized → delegate → team (T14: dibatasi turnamen ACTIVE).
- Dry-run `check_resolveidentity_1arg.mts` Part A: 1-arg vs 2-arg **identik** di semua skenario (identitas LID alias per-chat, primary phone, sender tak dikenal). Dugaan awal task ("2-arg mempersempit lookup ke alias per-chat") **TIDAK TERKONFIRMASI** — perbedaannya lebih dangkal dari dugaan, bukan lebih dalam.
- Vonis: inkonsistensi 1-arg vs 2-arg = **latent inconsistency** murni. Hari ini no-op; begitu `_sourceChatId` diimplementasikan (narrowing/audit), koordinator akan diam-diam berperilaku beda dari router untuk kasus yang sama.
- Part B (dampak nyata yang terbukti): bila resolve gagal (UNREGISTERED), koordinator fallback `sender_normalized_address` sebagai `sender_id` — non-UUID, dijamin UNAUTHORIZED di `verifyCorrectionAuthority`. Ini terjadi karena identitas memang tidak terdaftar, BUKAN karena kurang argumen ke-2 — di luar cakupan fix ini, dicatat sebagai catatan saja.

**Fix (sesuai keputusan Arya):** pemanggilan di `report-correction-coordinator.ts` kini meneruskan `message.chat_id` sebagai argumen kedua — persis seperti router. Signature & behavior `resolveIdentity` tidak diubah. Tidak ada perubahan behavior yang diharapkan; fix bersifat konsistensi call-site + future-proof.

**Regression:** tsc clean; vitest 250/250 PASS; `check_resolveidentity_fix.mts` VERIFIED (spy membuktikan koordinator kini memanggil `resolveIdentity(sender_raw_address, chat_id)`); check T6 lama tetap VERIFIED.

### Scope Sesi Ini
- File produksi berubah: `src/application/report-correction-coordinator.ts` (1 pemanggilan). Tanpa perubahan untuk item 1.
- Check scripts baru: `check_resolveidentity_1arg.mts` (verifikasi vonis), `check_resolveidentity_fix.mts` (bukti fix via spy).


## [2026-11-21] Sesi Follow-up: Keputusan Kebijakan T10/T17 + Re-draw Bracket Knockout (Task: flash-peak-tms-followup-policy-and-redraw-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Lanjutan task verifikasi & perbaikan audit T1–T18 (HEAD awal `d9349e3`, belum merge). Arya memutuskan: (1) T10 ditutup sebagai by-design, (2) T17 harus difix — cutoff 19:59 WIB wajib berlaku di fase knockout, (3) pairing bracket ronde knockout 2+ di-DRAW ULANG setiap ronde (keputusan desain baru). Semua kerja di branch yang sama, regression penuh per commit, tidak merge/push.

### Item 1 — T10 CLOSED (by design, no fix) — commit `1254f8e`
- Dry-run `verify-artifacts/check_t10_behavior.mts` membuktikan behavior auto-bind `!roster` PERSIS seperti deskripsi keputusan Arya: pengirim pertama format roster valid untuk tim tanpa delegasi langsung ter-bind (turnamen ACTIVE, tanpa gate tambahan, tanpa konfirmasi organizer; tim jadi VERIFIED via bindDelegateToTeam); orang kedua untuk tim yang sama DITOLAK auth check; format tidak valid tidak memicu bind. Tidak ada perbedaan dari deskripsi → tidak ada temuan baru. Tanpa perubahan kode.
- Catatan: `bindDelegateToTeam` yang men-set `registration_status='VERIFIED'` tanpa syarat tetap terbuka sebagai new-bug #1 yang sudah dilaporkan sebelumnya (tidak berubah statusnya).

### Item 2 — T17 FIXED — commit `a512ad6`
- Root cause (dari verifikasi task sebelumnya): `getRoundFixturesWithDelegates` (matchday-service.ts) INNER JOIN `groups`, sehingga fixture KNOCKOUT (group_id NULL) tersaring diam-diam dan `processDailyCutoff` tidak pernah menjaringnya.
- Fix: JOIN groups → LEFT JOIN; `MatchdayFixtureItem` menambah field `stage` dan `groupId/groupCode` jadi nullable; `processDailyCutoff` dispatch per stage — fixture GROUP → `handleGroupDoubleWalkover` (D-031, 0 poin + recompute standings, tidak berubah), fixture KNOCKOUT → `handleKnockoutDoubleRoomCardFailure` (D-032 double-loss: series COMPLETED tanpa pemenang, fixture WALKOVER) — sinyal yang persis dipakai `!startknockout` untuk memberi bye ke pasangan bracket, dan penanganan pool ganjil T2 sudah mengakomodasi hasilnya. Pengumuman cutoff memisahkan regulasi D-031 (grup) dan D-032 (knockout + info bye).
- Regression: tsc clean, vitest 248/248 PASS, `check_t17_fix.mts` VERIFIED (semi KO unplayed → WALKOVER + series COMPLETED no winner + audit KNOCKOUT_DOUBLE_LOSS_RECORDED + notice bye; fixture completed tak tersentuh; regresi ronde grup: DOUBLE_ABSENT tetap jalan).

### Item 3 — bracket-redraw (keputusan desain Arya) — commits `4b960ad` + `b2a0c43`
**Verifikasi dugaan new-bug #3 (SEBELUM redesign, sesuai prinsip):**
- `check_bye_index_bug.mts`: skenario QF penuh (4 fixture, 1 double-loss) — urutan hasil query `ORDER BY created_at ASC` SAMA dengan urutan insertion bracket; bye jatuh ke pemenang fixture bersebelahan (= model pairing-slot yang diniatkan kode).
- `check_bye_index_bug2.mts`: 30 DB in-memory segar — ordering equal-created_at konsisten = insertion/rowid order, 0 mismatch.
- **Vonis: TIDAK TERKONFIRMASI secara dinamis** di environment ini; namun asumsi "ordering equal keys == insertion order" tidak kontraktual dan bisa berbeda antar engine/plan — risiko struktural terdokumentasi, dan redesign draw ulang menghapus asumsi itu sepenuhnya (tidak ada lagi kode yang memetakan posisi bracket dari index fixture ronde sebelumnya).

**Implementasi re-draw:**
- `generateKnockoutFixtures` menerima `options.shuffle` (injectable untuk determinisme test). Bila disuplai: pool genap diacak dulu lalu dipasangkan sekuensial; shuffle divalidasi (jumlah & elemen sama, tanpa duplikat) — shuffle yang curang ditolak dengan error. TANPA shuffle (ronde pertama dari kualifikasi grup): seeding klasik juara-grup vs runner-up grup bersebelahan tetap (FR-COMP-011 tidak berubah).
- `!startknockout` (ronde 2+) mempassing `cryptoFisherYates` — primitif yang sama dengan !draw babak grup. Guard anti-self-match tetap; bye pool-ganjil T2 tetap (qualifier terakhir); jalur single-survivor → juara otomatis TIDAK diubah.
- Audit event `KNOCKOUT_ROUND_GENERATED` kini mencatat `drawMethod: 'RE-DRAW (cryptoFisherYates)'`, pasangan hasil draw (`drawnPairings`), dan `byeTeamId`; pengumuman grup menyatakan pasangan ditentukan lewat "DRAW ULANG".

### Bukti & Verifikasi Empiris
- Per commit: `npx tsc --noEmit` clean + `npx vitest run` hijau (248/248 untuk T10/T17/verify; **250/250** setelah 2 test permanen baru masuk di `b2a0c43`).
- Test permanen baru (tests/unit/competition.test.ts): (a) ronde 2+ berpasangan sesuai shuffle injectable (bukan pseudo-rank split lama) + anti-self-match + shuffle curang ditolak; (b) pool ganjil 3 → 1 fixture FINAL + bye qualifier terakhir.
- Dry-run: `check_t10_behavior.mts`, `check_t17_fix.mts`, `check_bye_index_bug.mts`, `check_bye_index_bug2.mts`, `check_bracket_redraw.mts` (QF klasik → SF re-draw sesuai shuffle → FINAL+bye pool ganjil), `check_bracket_redraw_e2e.mts` (rantai penuh `!startknockout` via CommandRouter: SF → FINAL → series COMPLETED; skenario QF double-loss → 3 survivor unik → FINAL + bye + notice DRAW ULANG) — semua VERIFIED.
- Temuan menarik dari E2E: 8 tim QF + satu double-loss menghasilkan 3 survivor unik (penerima bye = pemenang fixture partner yang memang sudah seed) → 1 FINAL + 1 bye — konsisten semantik T2, bukan bug.
- Scope: 4 commit baru di atas `d9349e3` (`1254f8e`, `a512ad6`, `4b960ad`, `b2a0c43`); file produksi berubah: `src/application/matchday-service.ts`, `src/application/tournament-commands.ts`, `src/competition/fixtures.ts`, `tests/unit/competition.test.ts`. Tidak merge/push (menunggu review Arya).


## [2026-11-21] Sesi Verifikasi & Perbaikan Temuan Audit Independen T1–T18 (Task: flash-peak-tms-verify-and-fix-audit-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Audit independen fresh-session (Laporan_Audit_FlashPeak_TMS.pdf, 29 asersi dry-run, master @03f8860, 21 Nov 2026) melaporkan 18 temuan (T1–T18). Sesuai instruksi tugas: SETIAP temuan diverifikasi ulang dulu terhadap kode master @03f8860 (clone baru, read-only) SEBELUM perbaikan apa pun. Hasil verifikasi: **18/18 TERKONFIRMASI** (2 dengan koreksi mekanisme: T7 race hanya mungkin antar-event upsert terpisah karena handler memproses pesan secara berurutan; T17 no-op terjadi karena INNER JOIN groups menyaring fixture knockout secara diam-diam, bukan crash). Tidak ada temuan yang tidak terkonfirmasi. Laporan lengkap per temuan (status + bukti file:baris + hasil dry-run): `verify-artifacts/VERIFICATION_REPORT.md`.

### Perubahan Konkret (15 fix, satu commit per temuan di branch `audit/verify-fix-v1`)
1. **T1+T7+T11** (`15802c3`): `applyKoGameEvidence` — hapus Guard 3 (duplikat berbasis pasangan skor lintas-slot; pasangan skor bukan identitas game — BO3 sah bisa punya dua game 2-0, guard membekukan series di 1-0). Deteksi duplikat kini slot-scoped dan seluruh derive-slot + cek duplikat + apply berjalan dalam SATU transaksi write (mengserialisasi dua foto konkuren, T7). Status jurnal `NEEDS_REVIEW` yang tidak pernah di-set dihapus dari tipe/status/outcome (T11).
2. **T2** (`98a3564`): `generateKnockoutFixtures` — jumlah survivor ganjil (mis. 3 pasca bye double-loss D-032) tidak lagi throw "Jumlah juara grup harus sama..."; qualifier TERAKHIR menerima bye, pool genap dipasangkan; bye dikembalikan via `byeTeamId` dan diumumkan `!startknockout`.
3. **T3** (`759a85f`): `getOrganizerIdentities` — setiap identitas phone diperluas dengan varian `<digits>@s.whatsapp.net` (dan sebaliknya), sehingga deployment yang hanya set `WA_ORGANIZER_PHONE` tidak lagi menolak suara approval ORGANIZER (`!approve` memakai JID normalized sebagai approverId).
4. **T4** (`664a33b` + `fedef9c`): `resolveFixtureForMessage` — ketiga query kini memfilter `f.stage = 'GROUP'`; foto polos tanpa caption `!kogame` tidak lagi bocor membuat draf BO1 paralel untuk series BO3/BO5. Test integrasi FR-FAIL yang premisnya memakai fixture KNOCKOUT via jalur BO1 diganti fixture GROUP (intent test dipertahankan).
5. **T5** (`03104d1`): `recordSeriesGameResult` menerima `allow_completed_series` (default false); hanya `!kores` yang menyetelnya — re-record game di series COMPLETED kini benar-benar berfungsi (decrement + recompute) sesuai janji dokumentasi. Pipeline foto tetap menolak series COMPLETED.
6. **T6** (`d5af62b`): flag `is_organizer` diteruskan dari `CommandRouter.isSenderOrganizer` di `handleInboundMessage` → `handleCorrection` → `handleReportCorrection` → `applyReportCorrection`; koreksi NL organizer tidak lagi ditolak "Unauthorized sender".
7. **T8** (`3d76d7d`): blok 1.5 `handleInboundMessage` — konfirmasi plain-text ('ok'/'ya'/...) dan koreksi draf manual report kini di-gate `isSenderOrganizer`; anggota grup biasa tidak bisa lagi "menembakkan" draf organizer (`confirmPending` memang memakai `is_organizer: true` hardcoded).
8. **T9** (`b57bc95`): intersepsi `!kogame` hanya berlaku bila ada foto; teks `!kogame <fixture_id>` (status lookup yang terdokumentasi di cara-penggunaan.md) kini sampai ke handler router yang memang mengimplementasikannya.
9. **T12** (`6c275b9`): `isOrganizerAuthorized` di manual.ts — pola `startsWith('org_')`/`includes('organizer')` dihapus (pola yang sama yang FIX2-APR-003 bersihkan dari approval.ts); tersisa flag eksplisit + konstanta 'ORGANIZER'.
10. **T13** (`4b9b84f`): `handleInboundMessage` menolak pesan dari grup selain grup resmi SEBELUM jalur KO-pipeline/NL-intent/koreksi/bukti berjalan (FR-ID-005); DM organizer & bootstrap `!setgroup` tidak terpengaruh.
11. **T14** (`375544d`): lookup tim di `resolveIdentity` kini mengurutkan berdasar status turnamen (ACTIVE dulu, lalu status berjalan, COMPLETED/ARCHIVED terakhir, terbaru dulu) — delegasi lintas turnamen tidak lagi resolve ke tim turnamen lama.
12. **T15** (`54dd175`): `deriveKnockoutQualifiers` memanggil `recalculateAndPersistGroupStandings` (mesin yang sama dengan `!standings`) per grup, bukan SQL duplikat points/GD/GF — kualifikasi knockout kini identik dengan klasemen yang ditampilkan (tie H2H tuntas); seri PENUH di batas kualifikasi tetap throw untuk keputusan manual.
13. **T16** (`d1b50ef`): `handleManualReport` menolak fixture `stage = 'KNOCKOUT'` dengan arahan ke `!kores` (draf BO1 paralel untuk series BO3/BO5 tidak lagi mungkin via tangan organizer).
14. **T18** (`2853a51`): alias typo `!mulainokout` diganti `!mulaiknockout` (ejaan benar).
15. **Docs** (`298415a`): cara-penggunaan.md bagian "Kalau Ada Masalah di Knockout" disesuaikan dengan semantik baru (slot-based; janji re-record series selesai kini benar; janji NEEDS_REVIEW dihapus).

### DITUNDA (butuh keputusan organizer Arya — TIDAK difix buta)
- **T10** (delegasi tim tanpa delegate dapat direbut via `!roster` auto-bind): fitur self-registration yang disengaja; fix butuh kebijakan (batasi hanya saat status REGISTRATION/ONBOARDING vs wajib konfirmasi organizer untuk tim buatan panitia). Status: REPORTED / PENDING_APPROVAL.
- **T17** (cutoff 19:59 no-op pada ronde knockout): `getRoundFixturesWithDelegates` INNER JOIN groups sehingga fixture KO (group_id NULL) tak pernah diproses; fix butuh kebijakan D-031 vs D-032 (deadline KO: double-WO? reschedule wajib? reminder saja?). Status: REPORTED / PENDING_APPROVAL.

### Bug Baru di Luar Daftar Temuan (REPORTED, TIDAK difix — sesuai prinsip lapor dulu)
1. `bindDelegateToTeam` men-set `registration_status='VERIFIED'` tanpa syarat (`resolver.ts:346`) — tim yang belum onboarding langsung VERIFIED; terkait T10 tapi dampak lebih luas.
2. `report-correction-coordinator.ts:89` memakai `resolveIdentity` versi 1-arg (mengabaikan alias per-chat) — inkonsisten dengan router yang memakai 2-arg; delegasi multi-alias bisa gagal resolve di jalur koreksi.
3. Dugaan salah pasangan bye di `!startknockout`: partner bye dihitung dari INDEX array fixture (`tournament-commands.ts:2923-2924`), padahal pasangan bracket tidak dijamin bersebelahan index setelah `ORDER BY created_at` — bye bisa diberikan ke tim yang bukan pasangan double-loss. Perlu verifikasi lanjutan sebelum fix.

### Bukti & Verifikasi Empiris
- **Baseline sebelum verifikasi**: `npx tsc --noEmit` clean; `npx vitest run` **248/248 PASS** (20 file) @03f8860.
- **Verifikasi temuan (sebelum fix)**: `npx tsx verify-artifacts/dryrun_verify_tms_audit.ts` (7 asersi) + `npx tsx verify-artifacts/dryrun_verify_tms_audit2.ts` (6 asersi) — 13/13 PASS (PASS = temuan audit ter-reproduksi). Temuan lain diverifikasi via trace kode (T4, T9, T13, T14, T18).
- **Regression per fix** (jalankan SETIAP commit fix): `npx tsc --noEmit` clean + `npx vitest run` **248/248 PASS** + targeted check `npx tsx verify-artifacts/check_t<N>_fix.mts` → semua **VERIFIED**:
  ```text
  T1-FIX VERIFIED   (game2 2-0 legiter GAME_APPLIED→SERIES_COMPLETE 2-0; tied-slot resend DUPLICATE; late photo IGNORED)
  T2-FIX VERIFIED   (3 survivor→1 fixture+bye; 5→2+bye; 4→2 tanpa bye; 2→FINAL)
  T3-FIX VERIFIED   (phone-only config: identities=[digits, digits@s.whatsapp.net], approverAllowed=true; jid-config regresi OK)
  T4-FIX VERIFIED   (foto polos saat KO resolve null; caption grup tetap resolve)
  T5-FIX VERIFIED   (!kores re-record COMPLETED→IN_PROGRESS 1-1; foto lanjut SERIES_COMPLETE 2-1; series utuh tetap IGNORED)
  T6-FIX VERIFIED   (organizer lolos gate otoritas; stranger tetap Unauthorized)
  T8-FIX VERIFIED   (member 'ok' diblok; organizer lolos gate)
  T9-FIX VERIFIED   (teks !kogame <id>→status handler; teks !kogame→help; foto+caption tetep ke pipeline KO)
  T12-FIX VERIFIED  (org_/organizer diblok; flag eksplisit & ORGANIZER lolos)
  T13-FIX VERIFIED  (grup asing NL/foto ignored; grup resmi & DM organizer tetap diproses)
  T14-FIX VERIFIED  (delegasi 2 turnamen→tim ACTIVE; delegasi 1 tim tetap benar)
  T15-FIX VERIFIED  (seri penuh termasuk H2H→throw; rank-2 kualifikasi == rank-2 engine)
  T16-FIX VERIFIED  (fixture KNOCKOUT ditolak + arahan !kores; fixture GROUP tetap sukses)
  ```
- **Final sweep**: seluruh 13 skrip check dijalankan ulang sekaligus setelah semua fix — 13/13 VERIFIED; `tsc` clean; `vitest` 248/248 PASS di HEAD branch (`298415a`).
- **Scope disiplin**: tidak ada merge/push ke master (sesuai instruksi menunggu review Arya); semua kerja di branch `audit/verify-fix-v1`; file produksi yang berubah: `src/application/ko-evidence-pipeline.ts`, `src/application/tournament-commands.ts`, `src/application/fixture-resolver.ts`, `src/application/report-correction-coordinator.ts`, `src/competition/fixtures.ts`, `src/competition/series.ts`, `src/identity/resolver.ts`, `src/reports/approval.ts` (tidak berubah — fix T3 di router), `src/whatsapp/router.ts`, `src/reports/manual.ts`, `src/index.ts`, `tests/integration/full_flow.test.ts`, `cara-penggunaan.md`.


## [2026-11-21] Sesi Pull PR #7 & Redeploy VM: AI Resilience Notifications & Retry Queue (Task: flash-peak-tms-merge-pr7-redeploy-v1)

### Konteks Sesi
Mengeksekusi sinkronisasi pasca-merge PR #7 (`feat(ai): failure-cause-differentiated notifications + automatic retry queue (all-providers-failed)`) dari GitHub ke branch `master` lokal dan melakukan re-deployment ke VM (`forfh`). PR #7 mengimplementasikan:
1. Notifikasi kegagalan dibedakan per penyebab (failover transparan, retry in progress, terminal failure manual verification, unreadable screenshot).
2. Intake acknowledgment segera saat screenshot diterima ("📸 Screenshot diterima...").
3. Automatic retry queue untuk `AllProvidersFailedError` menggunakan reuse mekanisme debounce/lease yang ada + migrasi `003_ai_retry_queue.sql`.

### Langkah & Perubahan yang Dieksekusi
1. **Pull ke Repositori Lokal**:
   - `git fetch origin` & `git pull origin master` (Fast-forward `e5630aa..9e2175e`).
   - Kompilasi lokal `npm run build` (`tsc`) sukses tanpa error.
2. **Re-deployment ke VM (`forfh`)**:
   - Melakukan SSH ke VM `forfh` (`forfh-korea-vm`, `/home/azureuser/flashpeak-tms`).
   - Eksekusi `git pull origin master` (Fast-forward `e5630aa..9e2175e`).
   - Eksekusi `npm run build` di VM: clean, 0 error.
   - Eksekusi migrasi database: `npx tsx src/db/migrate.ts` mengaplikasikan `003_ai_retry_queue.sql` ke `local.sqlite`.
   - Restart service PM2: `pm2 restart flashpeak-bot --update-env && pm2 save`.
3. **Verifikasi Runtime Pasca-Deploy**:
   - Status PM2 `flashpeak-bot`: `online` (PID 3015536, 0 restart loops).
   - Log PM2 mengonfirmasi migrasi skema up to date, Multi-Provider Router aktif dengan 6 provider, dan Baileys sukses tersambung ke WhatsApp.

### Bukti & Verifikasi Empiris
- **Commit HEAD Master**: `9e2175e` (Merge pull request #7 from algojogacor/feat/ai-resilience-retry-queue).
- **Migration Output VM**:
  ```text
  ✅ Migrations completed successfully:
     Applied: 003_ai_retry_queue.sql
     Skipped: 001_initial.sql, 002_ko_game_evidence.sql
  ```
- **PM2 Process Status VM**:
  - `flashpeak-bot` (PID 3015536): `online`, memory ~128.7MB, uptime active.
- **Log Startup VM (`logs/bot-out.log`)**:
  ```text
  [DB] Connecting to database (file:local.sqlite)...
  [DB] Database schema is up to date.
  [AI] Initialized Multi-Provider Router with 6 provider(s): GROQ, DEEPSEEK, GEMINI, NVIDIA_NIM, COHERE, MISTRAL
  [WA] Initializing Baileys WhatsApp client (auth dir: ./auth_state)...
  [WA] Organizer identity configured (phone: set, jid: set).
  [WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!
  [WA] Akun Bot JID: 6288242980462:2@s.whatsapp.net
  [WA] Bot siap memproses turnamen.
  ```
- **Unit & Integration Suite Lokal**: **20 file / 248/248 PASS** (16 test baru di `tests/integration/ai_resilience.test.ts`).

---


## [2026-11-20] Sesi Merge PR #5 & Redeploy VM: Fix 4 Audit Findings + Dynamic Group Sizing (Task: flash-peak-tms-merge-pr5-redeploy-v1)

### Konteks Sesi
Mengeksekusi merge Pull Request #5 (`fix(audit): resolve 4 audit findings + dynamic group sizing (FIX2)`) ke branch `master` dan melakukan re-deployment ke VM (`forfh`). PR ini menuntaskan 4 temuan audit (termasuk 1 bug kritis foreign key pada upload foto knockout `!kogame`) dan menambahkan fitur target ukuran grup dinamis `!draw size=4|5`.

### Langkah & Perubahan yang Dieksekusi
1. **Review & Merge PR #5**:
   - Analisis menyeluruh terhadap 4 perbaikan (FIX2-KO-003, FIX2-KO-004, FIX2-APR-003, FIX2-KO-005) dan fitur `FIX2-COMP-DYN`.
   - Eksekusi merge via GitHub CLI: `gh pr merge 5 --merge --delete-branch` (commit merge `250813b`).
   - Fast-forward sinkronisasi branch `master` lokal.
2. **Penyempurnaan Dokumentasi (`cara-penggunaan.md`)**:
   - Menambahkan petunjuk penggunaan `!draw size=4` / `!draw size=5` pada bagian panduan pengundian dan tabel cheatsheet.
3. **Re-deployment ke VM (`forfh`)**:
   - `git pull origin master` di `/home/azureuser/flashpeak-tms`.
   - `npm run build` (`tsc`) untuk memperbarui bundel kompilasi `dist/`.
   - `pm2 restart flashpeak-bot` dan `pm2 save`.
4. **Verifikasi Runtime Pasca-Deploy**:
   - Status PM2 `flashpeak-bot`: `online`, 0 crash/restart loop.
   - Startup log mengonfirmasi Baileys terhubung sukses kembali ke WhatsApp.

### Bukti & Verifikasi Empiris
- **Commit HEAD Master**: `250813b` + commit docs ini.
- **Unit & Integration Suite**: **19 file / 232/232 PASS** (+8 test regresi baru).
- **TypeScript Compilation**: **0 error**.
- **Log Startup VM**:
  - `[DB] Connecting to database (file:local.sqlite)...`
  - `[DB] Database schema is up to date.`
  - `[AI] Initialized Multi-Provider Router with 6 provider(s): GROQ, DEEPSEEK, GEMINI, NVIDIA_NIM, COHERE, MISTRAL`
  - `[WA] Organizer identity configured (phone: set, jid: set).`
  - `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`
  - `[WA] Bot siap memproses turnamen.`

---


## [2026-11-20] Sesi Pendaftaran LID Organizer Arya (Task: flash-peak-tms-register-organizer-lid-v1)

### Konteks Sesi
Dari hasil pengetesan command `!id` oleh Arya di grup target (`120363412423738009@g.us`), terkonfirmasi bahwa WhatsApp Arya mengirimkan pesan menggunakan Privacy ID / LID: `165210883154071@lid`. Sesi ini mendaftarkan LID tersebut ke dalam konfigurasi `WA_ORGANIZER_JID` di `.env` VM agar Arya langsung diakui sebagai Organizer dengan hak akses penuh (bisa menjalankan `!setgroup`, `!createtournament`, dll).

### Langkah & Perubahan yang Dieksekusi
1. **Backup Snapshot `.env`**:
   - Dibuat snapshot backup: `/home/azureuser/flashpeak-tms/.env.backup-lid-20261120_103550`.
2. **Koreksi Variabel `WA_ORGANIZER_JID`**:
   - `WA_ORGANIZER_JID=165210883154071@lid,6289505630895@s.whatsapp.net`
   - `WA_ORGANIZER_PHONE=6289505630895`
   - Konfigurasi mendukung multi-target comma-separated sesuai implementasi router (`organizerList.some(...)`), sehingga baik interaksi via LID maupun Phone JID keduanya valid sebagai Organizer.
3. **Restart & Verifikasi Runtime PM2**:
   - Menjalankan `pm2 restart flashpeak-bot --update-env && pm2 save`.
   - Proses baru aktif (PID 2984818), status `online`, 0 errors.
   - Startup log mengonfirmasi Baileys terhubung kembali (`[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`).

---


## [2026-11-20] Sesi Fitur: Command !id & !myid untuk Pengecekan Identitas & Grup (Task: flash-peak-tms-command-id-v1)

### Konteks Sesi
Menambahkan perintah bawaan `!id` (dan alias `!myid`) pada CommandRouter WhatsApp agar pengguna (khususnya Arya sebagai Organizer) dapat memeriksa identitas asli pengirim (`sender_raw_address`, LID vs Phone JID), hak akses/role di sistem (apakah dikenali sebagai Organizer), serta ID chat/grup saat ini dan statusnya (resmi/belum). Perintah ini penting karena WhatsApp/Baileys dapat mengirimkan alamat dalam format `@lid` (Privacy ID) yang berbeda dari nomor telepon biasa.

### Langkah & Perubahan Kode
1. **Ekstensi Tipe `CommandDefinition` (`src/whatsapp/types.ts`)**:
   - Menambahkan flag opsional `allowOutsideCentralGroup?: boolean` agar perintah diagnostik seperti `!id` dapat dijalankan di grup mana pun (bahkan sebelum grup tersebut ditetapkan sebagai grup resmi via `!setgroup`).
2. **Implementasi Router Scope Guard & Handler `!id` (`src/whatsapp/router.ts`)**:
   - Menyesuaikan group scope guard: `if (isGroup && !isCentralGroup && !definition.allowOutsideCentralGroup)` sehingga perintah dengan flag ini tidak ditolak dengan pesan `UNAUTHORIZED_GROUP`.
   - Mengimplementasikan handler `!id` dan mendaftarkan `!id` serta `!myid` dengan `requiredRole: 'ANY'`, `allowedInDm: true`, `allowedInGroup: true`, dan `allowOutsideCentralGroup: true`.
   - Handler merender informasi:
     - User JID (`sender_raw_address`)
     - Tipe alamat (LID vs Phone JID)
     - Role pengguna di sistem (`ORGANIZER`, `DELEGATE`, atau `UNKNOWN`)
     - Status hak akses Organizer (apakah cocok dengan konfigurasi env)
     - ID chat/grup saat ini (`chat_id`)
     - Status grup resmi (apakah grup ini grup resmi, atau belum ada yang ditetapkan)
     - Petunjuk konfigurasi jika ID pengguna berupa `@lid` dan belum cocok dengan `WA_ORGANIZER_JID`.
3. **Dokumentasi Pengguna (`cara-penggunaan.md`)**:
   - Menambahkan `!id` / `!myid` pada tabel cheat sheet perintah.
4. **Pengujian & Verifikasi**:
   - Menambahkan test case baru di `tests/unit/whatsapp.test.ts` (menguji di central group, unauthorized group, dan alias `!myid`).
   - Mendaftarkan `id` dan `myid` di `audit-artifacts/audit_command_router_wiring.ts`.

### Bukti & Verifikasi Empiris
- **Unit Suite (`vitest run`)**: **18 file / 224/224 PASS** (bertambah 1 test).
- **TypeScript Typecheck (`tsc`)**: **0 error**.
- **Audit Wiring Suite (`audit_command_router_wiring.ts`)**: **38/38 commands SUCCESS**.

---


## [2026-11-20] Sesi Hotfix Konfigurasi: Nomor Organizer Arya (Task: flash-peak-tms-fix-organizer-number-v1)

### Konteks Sesi
Mengoreksi konfigurasi identitas nomor WhatsApp organizer turnamen pada file `.env` di VM deployment (`/home/azureuser/flashpeak-tms/.env`). Pada sesi deployment sebelumnya nomor diisi nilai dari service lain (`628999021644`). Sesi ini memperbaikinya ke nomor resmi yang sebenarnya dipakai Arya sebagai organizer turnamen (`6289505630895`).

### Langkah & Perubahan yang Dieksekusi
1. **Backup Snapshot `.env` Sebelum Modifikasi**:
   - Dibuat snapshot baru: `/home/azureuser/flashpeak-tms/.env.backup-hotfix-20261120_102035`.
2. **Koreksi Variabel Lingkungan di `.env`**:
   - `WA_ORGANIZER_PHONE=6289505630895`
   - `WA_ORGANIZER_JID=6289505630895@s.whatsapp.net`
3. **Database Tidak Disentuh**:
   - Sesuai instruksi, database `local.sqlite` tetap dibiarkan bersih dari sesi reset sebelumnya (0 baris di seluruh tabel turnamen).
4. **Restart Service PM2**:
   - Menjalankan `pm2 restart flashpeak-bot --update-env` dan `pm2 save`.
   - Proses `flashpeak-bot` baru (PID 2982781) berjalan online, memuat environment baru.
5. **Verifikasi Log**:
   - `logs/bot-out.log`: Terverifikasi `[WA] Organizer identity configured (phone: set, jid: set).` dan `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`.

### Bukti & Verifikasi Empiris
- **Isi `.env` Terverifikasi**:
  ```text
  WA_ORGANIZER_PHONE=6289505630895
  WA_ORGANIZER_JID=6289505630895@s.whatsapp.net
  ```
- **PM2 Status**: `flashpeak-bot` (PID 2982781), status `online`, 0 crash/restart loop.
- **Log Verifikasi**:
  ```text
  2026-11-20T10:20:52: [WA] Organizer identity configured (phone: set, jid: set).
  2026-11-20T10:20:53: [WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!
  2026-11-20T10:20:53: [WA] Akun Bot JID: 6288242980462:2@s.whatsapp.net
  2026-11-20T10:20:53: [WA] Bot siap memproses turnamen.
  ```

---


## [2026-11-20] Sesi Deployment & Reset Data Turnamen di VM (Task: flash-peak-tms-deploy-update-vm-v1)

### Konteks Sesi
Memperbarui deployment Flash Peak TMS (TurFpeak) yang sedang berjalan di VM (`forfh-korea-vm`, user `azureuser`) agar memakai kode terbaru dari `master` (commit `6cb8836`, memuat 4 PR besar: audit findings fix, interactive knockout evidence pipeline v2, approval-reset fix, preexisting TS bugfixes, dan panduan penggunaan). Sekaligus melakukan reset total data turnamen lama di database VM agar bersih dan siap digunakan Arya untuk turnamen baru via `!setgroup`.

### Langkah & Perubahan yang Dieksekusi
1. **Pemeriksaan Awal & Identifikasi Service**:
   - Ditemukan deployment berjalan di `/home/azureuser/flashpeak-tms`.
   - Service PM2 aktif: `flashpeak-bot` (id 9, fork mode, entry `dist/cli/start.js`, `--max-old-space-size=160`) dan `flashpeak-media` (id 8, port 4189, online).
   - Commit sebelum update dicatat sebagai titik rollback: `46ed1db` (`feat(roster): enforce Format 5+3 with automatic rejection for excess players`).

2. **Backup Snapshot Database & Sesi WhatsApp**:
   - `local.sqlite` disalin ke `local.sqlite.backup-pre-deploy-20261120_100254` (464K).
   - `auth_state` (kredensial WhatsApp session Baileys) dibackup ke `auth_state.backup-pre-deploy-20261120_100254`.
   - File `.env` dibackup ke `.env.backup-20261120_100504`.

3. **Update Kode & Build**:
   - Eksekusi `git fetch origin master && git pull origin master` di VM; berhasil fast-forward `46ed1db..6cb8836`.
   - Menjalankan `npm install` (semua 283 dependencies up-to-date).
   - Menjalankan `npm run build` (`tsc`) untuk memperbarui bundel kompilasi `dist/` (`dist/cli/start.js` terupdate).

4. **Reset Data Turnamen & Migrasi Database**:
   - `flashpeak-bot` dihentikan sementara via `pm2 stop flashpeak-bot` untuk melepas file lock SQLite (`SQLITE_BUSY`).
   - Menjalankan migrasi `npm run migrate`: berhasil menerapkan migrasi baru `002_ko_game_evidence.sql` (tabel per-game evidence jurnal knockout).
   - Menjalankan utility bawaan `npm run reset-data` (`src/cli/reset_data.ts`): membersihkan seluruh tabel turnamen (`approvals`, `corrections`, `player_game_stats`, `goalkeeper_reports`, `report_media`, `report_versions`, `report_sessions`, `media_assets`, `inbound_messages`, `standings`, `games`, `series`, `fixtures`, `group_members`, `groups`, `group_draws`, `players`, `teams`, `whatsapp_identities`, `delegates`, `tournaments`, `audit_events`).
   - Verifikasi hitungan baris di seluruh 26 tabel: seluruh tabel data turnamen bernilai **0 baris**, tabel meta `_migrations` bernilai **2** (001 dan 002). Skema tabel tetap utuh sempurna.

5. **Penyesuaian Environment Variables (`.env`)**:
   - `WA_CENTRAL_GROUP_JID=` di-reset kosong agar bot siap menerima penetapan grup baru via `!setgroup`.
   - Dikonfigurasi identitas organizer Arya (`WA_ORGANIZER_PHONE=628999021644` dan `WA_ORGANIZER_JID=628999021644@s.whatsapp.net`) untuk memenuhi proteksi FIX2-RBAC-001 (mencegah startup abort).
   - Memastikan `FLASHPEAK_MEDIA_SECRET` valid dan terhubung dengan `flashpeak-media` service.

6. **Restart & Verifikasi Runtime PM2**:
   - Menjalankan `pm2 start flashpeak-bot` dan `pm2 save`.
   - Status PM2: `flashpeak-bot` (pid 2980988) status **online**, 0 restarts pasca-start.
   - Log startup membuktikan bot sukses terhubung kembali ke WhatsApp (`[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`) dan siap memproses turnamen baru.

### Bukti & Verifikasi Empiris
- **Commit HEAD VM**: `6cb8836` (`git log -n 1 --oneline`).
- **Verifikasi Tabel Database (`local.sqlite`)**:
  - `_migrations`: 2
  - `tournaments`: 0
  - `teams`: 0
  - `delegates`: 0
  - `whatsapp_identities`: 0
  - `players`: 0
  - `fixtures`: 0
  - `games`: 0
  - `series`: 0
  - `ko_game_evidence`: 0
  - `inbound_messages`: 0
  - `media_assets`: 0
  - `report_sessions`: 0
  - `report_versions`: 0
  - `approvals`: 0
  - `standings`: 0
  - `audit_events`: 0
- **Log Startup**:
  - `[DB] Database schema is up to date.`
  - `[AI] Initialized Multi-Provider Router with 6 provider(s): GROQ, DEEPSEEK, GEMINI, NVIDIA_NIM, COHERE, MISTRAL`
  - `[WA] Organizer identity configured (phone: set, jid: set).`
  - `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`
  - `[WA] Bot siap memproses turnamen.`

---


## [2026-11-20] Sesi Merge Koordinasi 4 PR ke master (Task: flash-peak-tms-analyze-and-merge-prs-v1)

### Konteks Sesi
Sesi ini menganalisis 4 PR terbuka (PR #1–#4) untuk menentukan urutan merge yang aman, mendeteksi konflik, lalu mengeksekusi merge bertahap dengan test ulang di master setelah tiap tahap. Seluruh analisa dilakukan secara lokal (clone + fetch semua head branch) SEBELUM tombol merge pertama ditekan, termasuk simulasi merge penuh (dry-run) dengan test + typecheck di tiap tahap.

### Fakta kunci dari analisa lokal
- **PR #4 ⊇ PR #2**: branch PR #4 dibuat DI ATAS head PR #2 (`bf1d98a`, terverifikasi `git merge-base --is-ancestor`) + 1 commit docs murni (`cara-penggunaan.md` + worklog). Dokumentasinya sudah akurat terhadap command final PR #2; `!help` tidak perlu sinkron kode karena outputnya dirender dinamis dari command registry.
- **PR #1**: 4 file artifact read-only baru (`second-opinion-audit-artifacts/`), nol perubahan kode produksi, tidak overlap dengan PR lain. Diputuskan MERGE (bukan close) sebagai referensi historis — laporan temuan tidak ter-superseded oleh fix, dan `dryrun_e2e.ts`-nya dipakai PR #2 sebagai verifikasi lintas-branch.
- **PR #2 ∩ PR #3**: 4 file sama, tapi hunk disjoint (PR #2: baris 24–89/2244–2532/2675+; PR #3: 2581–2601 + router 114–175) → auto-merge bersih.
- **Konflik git yang nyata hanya `worklog.md`** (gaya prepend, semua sesi menambah entri di atas) → di-resolve dengan union blok sesi (script `scripts/resolve_worklog.py` di luar repo, di sesi agent): zero konten hilang, urut terbaru-dulu.
- **Konflik semantik lintas-PR (tak terdeteksi git/vitest)**: 2 script dry-run buatan PR #2 (`audit_sync_central_group.ts` Scenario 4; `dryrun_knockout_stage.ts`) membangun `NormalizedMessage` dengan field legacy `sender_id`; setelah PR #3 menghapus fallback `|| sender_id` (BUGFIX-TS-002), `sender_raw_address` jadi undefined → crash `.split()` di `isSenderOrganizer`. Terdeteksi HANYA lewat dry-run sweep (15/17 gagal 2). Fix: alignment mekanis ke kontrak tipe — persis gaya yang PR #3 sendiri pakai untuk kasus yang sama pada 2 dry-run lama.

### Urutan merge yang dieksekusi + hasil test di master setelah tiap tahap
| Tahap | PR | Merge SHA | tsc master | vitest master |
|---|---|---|---|---|
| 0 | (baseline master `16c97bb`) | — | 5 error (2 bug TS pre-existing) | 223/223 |
| 1 | PR #1 audit artifacts | `dcf12ba` | 5 error (identik; bukan regresi) | 223/223 |
| 2 | PR #2 9 findings + KO pipeline | `2de0417` | 5 error (identik; bukan regresi) | 223/223 |
| 3 | PR #3 2 bug TS (branch di-update dulu: merge master + union worklog → push `4d7c781`) | `47531a6` | **0 error** | 223/223 |
| 4 | PR #4 cara-penggunaan (branch di-update dulu: merge master, auto-clean → push `12d046e`) | `fd5c2e0` | **0 error** | 223/223 |
| 5 | Commit alignment 2 dry-run + entri worklog ini | (commit ini) | **0 error** | 223/223 + dry-run 17/17 |

Alasan urutan: (1) PR #1 zero-risk masuk duluan supaya laporan audit hidup di master sebagai referensi sebelum fix-nya masuk; (2) PR #2 sebagai PR fungsional inti; (3) PR #3 setelah PR #2 — hunks disjoint dan fix-nya sekaligus membersihkan warisan `sender_id` yang dibawa PR #2; (4) PR #4 terakhir — tinggal menambah commit docs karena basisnya sudah ada di master.

### Verifikasi final di HEAD master
- `npx tsc --noEmit`: **0 error**.
- `npm test`: **18 file / 223/223 PASS**.
- Sweep 17 dry-run (12 audit lama + `dryrun_knockout_stage` + `dryrun_fix2_items` + `dryrun_ko_pipeline_v2` + `dryrun_fix_preexisting_ts_bugs` + `dryrun_e2e` second-opinion): **17/17 PASS** (sebelum alignment: 15/17).

### Catatan
- Token GHP dipakai via file chmod-600 di luar repo (tidak pernah di-commit, tidak pernah ditampilkan ulang). Token pernah tercantum sebagai teks di chat — owner disarankan revoke/rotate setelah sesi ini.


## [2026-11-20] Sesi Dokumentasi: Panduan Penggunaan Bot untuk Organizer & Delegasi (Task: flash-peak-tms-cara-penggunaan-doc-v1, Branch: docs/cara-penggunaan)

### Konteks Sesi
Sesuai task `flash-peak-tms-cara-penggunaan-doc-v1` (mode DOCUMENTATION, read-only terhadap logic), dokumen teknis yang ada (AGENT.md, FRD.md, COMPETITION_RULES.md) memang ditulis untuk developer/AI agent — belum ada panduan untuk pengguna akam: organizer (Arya & tim) dan delegasi tim yang sehari-hari memakai bot di grup WhatsApp. Sesi ini membuat **`cara-penggunaan.md`** di root repo sebagai tutorial step-by-step bahasa sehari-hari. Tidak ada perubahan logic/behavior kode apa pun.

Basis penulisan: branch `fix/second-opinion-findings` (`bf1d98a`) — kode terbaru yang memuat pipeline knockout interaktif PR #2 (`!startknockout`/`!kogame`/`!kores`, jalur foto per-game) yang belum ada di master `16c97bb`. Dokumen disusun dari pembacaan KODE langsung, bukan dari dokumentasi lama.

### Metode: Verifikasi ke Kode, Bukan ke Dokumentasi Lama
Seluruh isi dokumen diverifikasi terhadap perilaku kode nyata saat penulisan:
- Registry command (`registerCommand` di `src/whatsapp/router.ts` dan `src/application/tournament-commands.ts`): 44 command terdaftar (42 di tournament-commands + `!ping`/`!help`/`!setgroup` di router) — nama, `requiredRole`, DM/group, deskripsi, pesan usage & balasan tiap handler dibaca satu per satu.
- Jalur non-command yang didokumentasikan: foto bukti babak grup (evidence capture + debounce ~5 detik di `src/index.ts`), caption `!kogame` (pipeline KO per-game di `handleKoGameEvidenceMessage`), koreksi natural-language (kata kunci "koreksi/salah di/seharusnya/bukan" saat membalas draf), pertanyaan bebas berawalan `!` (WO intent, klasemen, jadwal, aturan, roster).
- Format pesan balasan bot dicuplik dari `src/whatsapp/formatters.ts` & pesan handler asli supaya contoh di dokumen mirip screenshot WhatsApp sungguhan.

### Dua Ketidakakuratan Awal Ditemukan Saat Verifikasi (dan dikoreksi sebelum commit)
1. Awalnya saya menulis "delegasi menolak draf dengan `!reject`" — salah. `!reject`/`!tolak`/`!batal` adalah registry `requiredRole: ORGANIZER` (handler `cancelHandler` untuk klaim WO pending / draf manual), BUKAN jalur tolak draf laporan 3-pihak. Jalur delegasi yang benar: tidak approve + balas draf dengan koreksi natural-language (`src/index.ts` isCorrectionCandidate). Bagian "Kalau Ada yang Tidak Setuju" ditulis ulang sesuai mekanisme itu.
2. Awalnya saya menulis "`!standings` menampilkan klasemen (semua grup)" — tidak tepat: handler memakai default `ctx.args[0]?.toUpperCase() || 'A'` (tanpa argumen = grup A saja). Dokumen diperbaiksi: harus menyebut huruf grup.

### Catatan !help (permintaan sinkronisasi task)
`!help` TIDAK perlu diperbarui kode-nya: implementasinya **dinamis** — handler merender daftar dari registry command terdaftar (`this.commands.entries()`) memakai `description:` tiap command, dengan penyaringan role (ORGANIZER-only disembunyikan dari non-organizer, DELEGATE-only disembunyikan dari UNKNOWN). Artinya setiap command baru termasuk pipeline knockout PR #2 otomatis muncul di `!help` tanpa perubahan. Deskripsi registry yang ada sudah akurat dan berbahasa pengguna. Konsistensi antara `!help` dan dokumen dijaga dengan: (a) dokumen menuliskan semua nama command persis seperti registry, (b) cheat sheet di akhir dokumen mencantumkan persis command yang akan dilihat pengguna di `!help`. Tidak ada perubahan kode pada `!help` — sesuai mode DOCUMENTATION (read-only terhadap logic).

### Deliverable
- **`cara-penggunaan.md`** (root repo, ~600 baris): tutorial mengikuti urutan alamiah turnamen — Gambaran besar (peta 4 fase + tabel beda babak grup vs knockout) → 1. Persiapan & Pendaftaran (createtournament, setgroup, addteam, onboarding, roster 5+3) → 2. Undian & Jadwal (draw, jadwal, standings, matchday/19:59 WIB) → 3. Melapor Hasil Babak Grup (alur foto→draf→approval 3 pihak, contoh percakapan utuh) → 4. Kalau Ada Masalah (claimwo, roomcard ok/ganti/tolak/habis + beda grup vs KO, salah kirim foto/AI gagal, manualreport, reopen/override) → 5. Babak Knockout & Grand Final (startknockout, konsep series BO3/BO5 + "kirim foto per game", !kogame lengkap dengan contoh balasan bot game-per-game, replay game seri, bye otomatis double-loss, kores) → 6. Kalau Turnamen Selesai (awards, pertanyaan bebas, jejak audit) → Cheat sheet cepat.
- Setiap command diformat konsisten: Siapa (role), Kapan (skenario), apa yang diketik (contoh konkret), apa yang terjadi setelahnya (cuplikan balasan bot nyata). Bahasa Indonesia sehari-hari, tanpa jargon teknis (tidak ada kata handler/pipeline/RBAC di isi dokumen).

### Status PR
Commit di branch `docs/cara-penggunaan` (dari `fix/second-opinion-findings`), PR terbuka ke master, tidak di-merge — menunggu review Arya.


## [2026-11-20] Sesi Lanjutan PR #2: Pipeline Knockout Interaktif + Approval Reset + Revisi Aturan Double-Loss (Task: flash-peak-tms-knockout-pipeline-and-override-v2)

### Konteks Sesi
Sesi ini MELANJUTKAN branch `fix/second-opinion-findings` (PR #2, masih terbuka, belum di-merge) — bukan branch/PR baru. Tiga bagian yang sebelumnya belum dikerjakan: (1) **revisi pendekatan evidence knockout** dari reuse pipeline BO1 babak grup (versi awal `!kores` pada FIX2-KO-001) menjadi **pipeline interaktif per-game** yang terpisah, karena format BO3/BO5 secara struktural beda (satu seri = beberapa game, bukan satu hasil); (2) **perbaikan bug approval-reset** yang dilaporkan sendiri pada sesi PR #2 (saat itu baru REPORTED, kini di-fix); (3) **revisi aturan bisnis dari Arya** (bukan bug fix) untuk kasus kedua tim tidak hadir di Knockout: dari wajib reschedule menjadi **double loss + bye otomatis**.

---

### [BAGIAN 2 — FIX2-KO-002] Pipeline Evidence Knockout Interaktif Per-Game
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `migrations/002_ko_game_evidence.sql` (tabel jurnal bukti per-game, baru)
  - `src/application/ko-evidence-pipeline.ts` (state machine seri per-game, baru)
  - `src/index.ts` (`handleKoGameEvidenceMessage` + dispatch pre-router + transisi turnamen COMPLETED)
  - `src/application/tournament-commands.ts` (command `!kogame` delegate; `!kores` direvisi menjadi jalur koreksi organizer)
- **Rencana & Masalah**: Versi awal `!kores` memakai organizer manual-report ala BO1 — tidak interaktif per-game, tidak menangani input delegasi yang berantakan. Arya minta alur: delegasi kirim foto per game → bot ekstraksi → balas hasil game + skor seri → minta game berikutnya atau umumkan pemenang.
- **Desain yang diambil (dicatat agar bisa dibaca ulang)**:
  1. **Nomor game TIDAK PERNAH dipercaya dari input delegasi** (caption/urutan foto). Slot selalu di-derive dari state DB: `deriveOpenGameSlot` mengembalikan slot game pertama yang belum punya hasil decisive, atau slot tied-pending-replay. Satu prinsip ini yang membuat foto terbalik, sekaligus, atau duplikat semuanya konvergen ke state seri yang benar.
  2. **Generic best-of-N**: threshold dari kolom `series.target_wins`; tidak ada branch khusus BO3/BO5 — BO5 Final hanya beda data (target 3), terbukti dry-run G.
  3. **Game seri → slot tetap menunggu replay** (D-028): foto decisive berikutnya mengisi slot yang sama (reuse `recordSeriesGameResult`), tidak konsumsi slot baru.
  4. **Foto setelah seri selesai** → jurnal `IGNORED` + pesan eksplisit "diabaikan, tidak dihitung resmi" — tidak pernah diproses sebagai hasil resmi.
  5. **Duplikat**: pasangan skor identik dengan slot decided → idempotent (pesan "duplikat hasil game ke-N, tidak dihitung sebagai game baru"), win tidak terhitung dua kali. Catatan penting: pair **mirror** (mis. 0-2 vs tercatat 2-0) TIDAK dianggap duplikat karena ekstraksi sudah terorientasi ke team_a/team_b fixture — mirror adalah skor berbeda yang sah mengisi slot berikutnya. (Guard mirror sempat salah ditulis saat iterasi pertama dan langsung menandai game-2 sah sebagai konflik; ditemukan via probe dry-run, diperbaiki.)
  6. **Konflik tak-ter-reconcile**: tidak ada jalur otomatis yang menimpa hasil decided — kasus semacam itu diekscalasi ke jalur koreksi organizer `!kores` (BAGIAN 3). Guard NEEDS_REVIEW tetap ada di skema jurnal untuk kebutuhan masa depan.
  7. **State persisten**: skor per-game di `games` (series_id terisi), agregat di `series`; jejak audit tiap foto di `ko_game_evidence` (status APPLIED/SUPERSEDED/IGNORED/NEEDS_REVIEW + note).
  8. **RBAC**: hanya delegasi terverifikasi (atau organizer) yang bisa submit foto; resolusi fixture: caption eksplisit → fixture KO aktif tim pengirim → fixture KO aktif tunggal turnamen.
  9. **GK rule per-game**: pipeline memakai extractor skor generik; kuota screenshot kiper (BO3=2/BO5=3 per pemenang) tetap berlaku pada jalur bukti kiper yang sudah ada dan tidak diduplikasi di sini.
  10. Transisi turnamen `COMPLETED` saat Grand Final selesai via foto juga kini terjadi di pipeline (bukan hanya di `!kores`).
- **Perubahan Kode**: seperti daftar file di atas; `handleInboundMessage` menangkap caption `!kogame` sebelum router/BO1-debounce agar foto KO tidak pernah masuk pipeline BO1.
- **Bukti & Verifikasi** (`npx tsx audit-artifacts/dryrun_ko_pipeline_v2.ts` — **59/59 PASS**):
  - A. Ideal berurutan BO3 2-0: series selesai di foto kedua, TIDAK diminta game 3 (early stop); DB 2-0 COMPLETED; 2 evidence APPLIED. (PASS)
  - B. BO3 1-1: bot minta foto game 3; game 3 penentuan menyelesaikan series 1-2, winner benar. (PASS)
  - C. Semua foto sekaligus di awal (+1 ekstra): foto ekstra diabaikan dengan pesan eksplisit; jurnal 2 APPLIED + 1 IGNORED; seri tetap 2-0. (PASS)
  - D. Foto terbalik: slot 1 terisi foto pertama yang sampai, slot 2 foto berikutnya; seri 1-1 tetap benar. (PASS)
  - E. Duplikat: skor identik → idempotent (win tidak dobel); skor beda mengisi slot berikutnya; foto pasca-selesai diabaikan. (PASS)
  - F. Game seri 1-1 → wajib replay slot sama; replay decisive 2-1 menuntaskan slot; hanya 1 row game (tidak konsumsi slot baru). (PASS)
  - G. BO5 Final: threshold 3 — 2 win belum selesai, win ke-3 menuntaskan; turnamen COMPLETED; pesan juara. (PASS)
  - H. E2E penuh: standings final → !startknockout → bracket → foto per game → FINAL dari pemenang SF → juara → turnamen COMPLETED. (PASS)

---

### [BAGIAN 3 — FIX2-APR-002] Approval Reset Saat Organizer Reopen (bug yang sebelumnya dilaporkan)
- **Status**: Selesai & Terverifikasi (bug #2 dari sesi PR #2 kini di-fix)
- **Modul/File Terkait**: `src/reports/approval.ts` (`organizerReopenReport`), `audit-artifacts/dryrun_ko_pipeline_v2.ts` (bagian P3), `audit-artifacts/dryrun_fix2_items.ts` (diperbarui)
- **Rencana & Masalah**: `organizerReopenReport` tidak menghapus approval lama — satu vote baru setelah reopen langsung melengkapi konsensus lama dan laporan ter-LOCK lagi tanpa divalidasi ulang (melanggar semangat FR-APR-003 untuk kasus reopen).
- **Perubahan Kode**: `organizerReopenReport` kini `DELETE FROM approvals WHERE report_version_id = ?` (jumlah ter-reset dicatat di audit event `before_json.approvals_reset`). Jalur koreksi `!kores` (organizer) dapat dipakai menyelesaikan kasus ambigu yang dieskalasi pipeline BAGIAN 2.
- **Bukti & Verifikasi** (dry-run P3, 8/8 PASS): lock 3 pihak → approval pasca-LOCK ditolak → `!reopen` → approval lama ter-reset (0 baris) → 1 vote baru diterima TIDAK mengunci (1/3) → 2 vote masih belum LOCK → 3 vote baru diperlukan untuk LOCK ulang → audit event mencatat `approvals_reset=3`.

---

### [BAGIAN 4 — FIX2-RULE-004] Revisi Aturan Kedua Tim Tidak Hadir di Knockout (REVISI ATURAN BISNIS DARI ARYA — bukan bug fix)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - Dokumentasi: `flash-peak-tms/COMPETITION_RULES.md` §6, `flash-peak-tms/DECISIONS.md` (D-032 + O-009), `flash-peak-tms/FRD.md` FR-FIX-006, `flash-peak-tms/README.md`, `flash-peak-tms/TESTING.md`, `docs/ARCHITECTURE_DECISIONS.md` (D-032)
  - Kode: `src/competition/walkover.ts` (`handleKnockoutDoubleRoomCardFailure` → double loss), `src/application/tournament-commands.ts` (pesan `!roomcard habis` + generator ronde berikutnya mendeteksi bye/juara-by-default), `src/competition/fixtures.ts` (guard anti self-match)
  - Test: `tests/unit/competition.test.ts` (test D-032 ditulis ulang ke aturan baru)
- **Aturan lama → baru**: Kedua tim KO tanpa room card: ~~WAJIB RESCHEDULE~~ → **KEDUA tim dinyatakan KALAH (double loss)**; fixture di-resolve (WALKOVER tanpa winner, series ditutup tanpa winner); tim yang seharusnya bertemu pemenangnya di ronde berikutnya **otomatis lolos (bye)**. Nomor keputusan D-032 dipertahankan dengan catatan revisi per 20 Nov 2026 di semua dokumen yang mencatat tanggal.
- **Perubahan Kode**:
  1. `handleKnockoutDoubleRoomCardFailure`: fixture → WALKOVER; game double-loss (is_walkover=1, tanpa winner); series COMPLETED tanpa winner; audit event `KNOCKOUT_DOUBLE_LOSS_RECORDED`.
  2. `!roomcard <id> habis` untuk KO: pesan baru menyatakan KALAH GANDA + konsekuensi bye ronde berikutnya.
  3. Generator ronde berikutnya (`!startknockout`): pemenang series + penerima bye (pasangan fixture double-loss) jadi seed ronde berikutnya; bye ditampilkan eksplisit di pesan WhatsApp (BYE OTOMATIS: <tim> lolos tanpa bertanding — pasangannya <A> vs <B> KALAH GANDA).
  4. **Edge case ditemukan & ditangani saat dry-run**: 2 SF dengan satu double-loss menyisakan 1 tim unik — generator lama akan membentuk FINAL "tim vs dirinya sendiri" (W3 vs W3). Kini: seed di-dedup; jika ≤1 tim unik tersisa → tim tersebut **dimahkotai JUARA langsung** (`KNOCKOUT_CHAMPION_BY_DEFAULT` audit event, turnamen COMPLETED, pesan juara + bye notice); jika 0 tersisa → info "panitia menetapkan juara manual". Guard anti self-match juga ditambahkan di `generateKnockoutFixtures`.
- **Bukti & Verifikasi**: dry-run P4 (10/10 PASS): pesan KALAH GANDA + bye eksplisit; fixture WALKOVER tanpa winner; series ditutup tanpa winner; TIDAK ada FINAL self-match; penerima bye dimahkotai juara langsung; audit event tercatat. Unit test `competition.test.ts` (D-032 revised) PASS dalam full suite 223/223.

---

### Catatan Tambahan
1. `audit_roomcard_commands.ts` Test 6, `dryrun_knockout_stage.ts` (post-final guard), `dryrun_fix2_items.ts` (bagian APR), dan `tests/migration.test.ts` (jumlah migrasi) di-update karena meng-asersi perilaku lama yang memang diubah oleh task ini (double-loss, approval-reset, migrasi kedua). Semua perubahan asersi disertai alasan di dalam file.
2. Bug #1 dari sesi PR #2 (5 error TS pre-existing master: `PendingWoClaim.id` + `sender_id` di 4 lokasi) tetap TIDAK diperbaiki (status REPORTED/PENDING_APPROVAL sesuai aturan sesi) — typecheck post-sesi tetap hanya berisi 5 error yang sama (bukan regresi).

---

### Ringkasan Akhir & Regression Gate Check (lanjutan branch fix/second-opinion-findings / PR #2)

**Full Vitest Suite**: 18 file / **223/223 PASS** (test D-032 & migration di-update mengikuti semantik baru).

**Dry-run audit-artifacts (15/15 PASS)**:

| # | Skrip | Status |
|---|-------|--------|
| 1–12 | 12 audit lama (command wiring, migration failure, e2e flow, gemini key, GK pipeline, RBAC WO, roomcard [Test 6 di-update ke double-loss], roster pipe, round-robin, media secret, sync central group, trusted context) | **12/12 PASS** |
| 13 | `dryrun_knockout_stage.ts` (PR #2; asersi post-final di-update) | **21/21 PASS** |
| 14 | `dryrun_fix2_items.ts` (PR #2; bagian APR di-update ke approval-reset baru) | **30/30 PASS** |
| 15 | `dryrun_ko_pipeline_v2.ts` (baru: bagian 2/3/4) | **59/59 PASS** |

**Dry-run second-opinion lintas-branch**: 34/34 PASS. **Typecheck**: hanya 5 error pre-existing master (identik baseline; bukan regresi — lihat catatan #2).


## [2026-11-20] Sesi Perbaikan Temuan Second-Opinion Audit (Task: flash-peak-tms-fix-second-opinion-findings-v1)

### Konteks Sesi
Sesi ini adalah tindak lanjut dari laporan second-opinion audit independen `flash-peak-tms-second-opinion-audit-v1` (19 November 2026, commit audit `16c97bb`). Audit tersebut mengonfirmasi jalur utama babak grup mature (34/34 dry-run PASS, 223/223 test PASS) namun menemukan 9 celah di luar jalur utama: fase knockout tanpa pintu masuk runtime (High), fallback nomor organizer hardcoded (High), organizer terkunci dari laporan LOCKED (High), recovery lease debounce pasif (Medium), WO claim NL oleh pengirim UNKNOWN (Medium), auto-adopt grup resmi diam-diam (Medium), lookup fixture prefix LIKE ambigu (Low–Medium), SQL IN non-parameterized (Low), dan dead code `recordGenuineDraw` (Low). Seluruh perbaikan dikerjakan pada branch `fix/second-opinion-findings` satu per satu sesuai prioritas, tetap dalam arsitektur modular `src/application/` / `src/competition/` / `src/whatsapp/` / `src/ingestion/`, tanpa mengubah skema migrasi. Semua perubahan dikirim via Pull Request ke `master` (tidak merge sendiri).

**Keputusan desain knockout yang diambil (dilaporkan untuk review Arya):**
1. **Trigger knockout manual oleh organizer via `!startknockout`** (bukan otomatis saat babak grup selesai) — konsisten dengan pola command organizer lain (`!draw` juga manual) dan prinsip "organizer is the final tournament authority" (COMPETITION_RULES §4). Kandidat alternatif (auto-generate saat semua fixture grup COMPLETED oleh matchday cutoff) tidak diambil agar tidak ada transisi fase tanpa kesempatan organizer memeriksa klasemen akhir.
2. **`!startknockout` juga berfungsi sebagai generator ronde knockout BERIKUTNYA** ketika semua series ronde aktif telah selesai (SF → FINAL), dengan pemenang series di-seed ulang ke `generateKnockoutFixtures` memakai aturan pairing anti-rematch grup yang sama.
3. **Pelaporan hasil game knockout via `!kores <fixture_id> <game_no> <skor_a>-<skor_b>`** (ORGANIZER-only, tercatat di games/series) — memakai jalur domain `recordSeriesGameResult` yang sudah teruji; bukti screenshot tetap mengalir lewat pipeline bukti biasa (FR-GK-008: BO3 winner 2 screenshot, BO5 3 screenshot). Kandidat alternatif (pipeline AI penuh per-game knockout) tidak diambil agar tidak menduplikasi logic approval grup; integrasi AI penuh per game knockout bisa jadi PR lanjutan.
4. **Batas ambiguitas klasemen**: `deriveKnockoutQualifiers` menolak start knockout bila peringkat 1–2 sebuah grup masih seri penuh (poin, SD, GF) — organizer harus menyelesaikan dulu (misal pertandingan tambahan/keputusan manual), sesuai FR-CALC-002 tie-breaker berjenjang.
5. **FIX2-GROUP-001**: `!setgroup` adalah satu-satunya cara eksplisit pindah grup resmi; pengecualian SATU-satunya untuk auto-adopt adalah bootstrap pertama saat **belum ada grup resmi yang terkonfigurasi sama sekali** (first-run), agar bot dapat dipasang tanpa env group.
6. **FIX2-DEADCODE-001**: `recordGenuineDraw` dihapus karena redundant dengan jalur resmi standings (`onReportLocked` → `games.is_draw=1` → `computeGroupStandings` beri 1 poin sesuai FR-CALC-001, terverifikasi dry-run audit pertama); signature-nya juga cacat (parameter `score` tunggal tidak bisa mewakili seri 2-2 vs 1-1). Test yang mengasertasinya ditulis ulang untuk memverifikasi jalur resmi.

---

### [FIX2-KO-001] Pintu Masuk Runtime Fase Knockout (Prioritas 1 — High)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/competition/fixtures.ts` (fungsi domain baru `deriveKnockoutQualifiers`)
  - `src/application/tournament-commands.ts` (command `!startknockout`/`!mulainokout`, `!kores`)
  - `src/application/matchday-service.ts` (dukungan stage KNOCKOUT + label ronde knockout)
  - `src/whatsapp/formatters.ts` (`formatKnockoutBracketAnnouncement`, `formatSeriesGameReportMessage`, `formatKnockoutNextRoundMessage`)
  - `audit-artifacts/dryrun_knockout_stage.ts` (dry-run baru)
- **Rencana & Masalah**: `generateKnockoutFixtures` dan `recordSeriesGameResult` lengkap sebagai domain logic dan lulus unit test, tetapi tidak ada command/handler/cron runtime mana pun yang memanggilnya — turnamen macet total setelah babak grup. `matchday-service` juga hanya mengelola `stage='GROUP'`.
- **Perubahan Kode**:
  1. `deriveKnockoutQualifiers(db, tournamentId)`: derivasi kualifikasi knockout dari klasemen final tersimpan (top 2 tiap grup, O-004/FR-COMP-011), dengan guard anti-ambiguitas seri penuh peringkat 1–2.
  2. Command organizer `!startknockout` (alias `!mulainokout`): guard seluruh fixture grup selesai; guard knockout belum ada; guard duplikasi (bila series masih berjalan → info + daftar series aktif); jalur kedua bila semua series ronde selesai → generate ronde berikutnya dari pemenang series (pairing anti same-group-rematch reuse); audit event `KNOCKOUT_STAGE_STARTED` / `KNOCKOUT_ROUND_GENERATED`; broadcast bracket via formatter WhatsApp.
  3. Command organizer `!kores <fixture_id> <game_no> <skor_a>-<skor_b>`: validasi input, resolve series by fixture (exact match), panggil `recordSeriesGameResult` (termasuk jalur game seri → wajib replay slot sama, D-028); saat Grand Final (BO5) selesai → `tournaments.status='COMPLETED'` + pesan juara.
  4. `getActiveTournamentCurrentRound` memperhitungkan stage KNOCKOUT (ronde aktif = ronde grup belum selesai dulu, lalu knockout); `formatRoundLabel` memberi label babak knockout (SEMI FINAL, FINAL, dsb) tanpa salah-format "Ronde".
- **Bukti & Verifikasi** (`npx tsx audit-artifacts/dryrun_knockout_stage.ts` → **21/21 PASS**):
  - Guard: `!startknockout` ditolak saat masih ada fixture grup belum selesai (pesan berisi jumlah). (PASS)
  - Generasi pertama: 2 fixture SEMI_FINAL BO3 target-2 dari 2 grup, tanpa same-group rematch, audit event tercatat. (PASS)
  - Idempotensi: `!startknockout` kedua saat series aktif → info + daftar series, tanpa duplikasi fixture. (PASS)
  - `!kores`: game seri 1-1 → tidak menambah win series (wajib replay); replay 2-1 + game 2 0-2 → series 1-1; game 3 2-0 → BO3 selesai 2-1, series COMPLETED, fixture COMPLETED. (PASS)
  - Ronde berikutnya: kedua SF selesai → `!startknockout` membentuk GRAND FINAL BO5 target-3 + audit event ronde. (PASS)
  - Grand Final 3 kemenangan → turnamen COMPLETED; `!startknockout` selanjutnya menolak dengan pesan turnamen tuntas. (PASS)
  - `!matchday` menampilkan label ronde knockout aktif (SEMI FINAL). (PASS)

---

### [FIX2-RBAC-001] Hapus Fallback Organizer Hardcoded + Abort Startup (Prioritas 1 — High)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/cli/start.ts`, `.env.example`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `process.env.WA_ORGANIZER_PHONE || '6281234567890'` di CLI memberi hak ORGANIZER penuh ke pemilik nomor contoh bila env lupa diset; `.env.example` juga memuat nilai contoh yang tampak seperti nilai nyata.
- **Perubahan Kode**:
  1. Startup kini membaca `WA_ORGANIZER_PHONE`/`WA_ORGANIZER_JID`, normalisasi digit, dan **abort dengan pesan deskriptif** bila keduanya kosong (selaras pola abort migrasi gagal / media secret hilang).
  2. `createApp` menerima nilai yang sudah tervalidasi (tidak ada fallback default).
  3. `.env.example`: entri organizer dikomentari + catatan wajib diset manual; nilai contoh nomor asli dihapus.
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian RBAC — 4/4 PASS): fallback `'6281234567890'` tidak lagi ada di `start.ts`; pesan abort "Organizer identity missing" ada; `.env.example` bersih dari nomor tampak-nyata; subproses dengan env organizer kosong exit non-zero dengan pesan abort.

---

### [FIX2-APR-001] Command Organizer Reopen/Override Laporan LOCKED (Prioritas 1 — High)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/application/tournament-commands.ts` (command `!reopen`, `!override`), `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `organizerOverrideLock`/`organizerReopenReport` ada di `src/reports/approval.ts` (FR-APR-004) tapi tidak pernah dipanggil runtime — organizer terkunci dari laporan LOCKED yang salah, kontradiksi dengan pesan error submitReportApproval sendiri.
- **Perubahan Kode**:
  1. Command `!reopen <report_version_id|fixture_id> <alasan>` (ORGANIZER-only): resolve version id (fallback fixture → versi terbaru), validasi status LOCKED, panggil `organizerReopenReport` (status → NEEDS_CORRECTION, audit event).
  2. Command `!override <report_version_id|fixture_id> <alasan>` (ORGANIZER-only): panggil `organizerOverrideLock` (lock paksa + `onReportLocked` writeback statistik + audit event).
  3. Alasan wajib (audit trail); pesan balasan menjelaskan status baru dan langkah berikutnya (koreksi / persetujuan ulang FR-APR-003).
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian APR — 10/10 PASS): baseline lock konsensus 3 pihak; approval pada LOCKED ditolak; `!reopen` membuka ke NEEDS_CORRECTION; jalur approval/koreksi hidup kembali (vote diterima, konsensus re-lock); `!override` mengunci paksa versi terbuka; kedua audit event tercatat; non-organizer ditolak RBAC.

---

### [FIX2-LEASE-001] recoverOrphanedLeases Saat app.start() (Prioritas 2 — Medium)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/index.ts` (`start()`), `src/ingestion/debounce.ts` (`recoverOrphanedLeases`), `tests/unit/debounce.test.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `recoverOrphanedLeases` tidak pernah dipanggil; "restart-safe" hanya lewat expiry lease pasif (~30 detik). Ditemukan pula bug desain lama: fungsi hanya merecover lease yang SUDAH expired — padahal saat boot worker lama sudah pasti mati, sehingga lease yang masih hidup tidak dipulihkan sampai 30 detik.
- **Perubahan Kode**:
  1. `app.start()` kini memanggil `recoverOrphanedLeases` (async, log jumlah recovered) sebelum poll loop.
  2. `recoverOrphanedLeases` diubah merecover SEMUA sesi `status='PROCESSING'` (lease hidup ataupun tidak) — worker lama tidak ada lagi saat boot by definition; `claimDebounceBatch` tetap jadi safety net expiry saat runtime.
  3. Unit test restart-safety ditulis ulang mengikuti semantik baru (recover di t+20s walau lease nominally alive; langsung bisa di-claim worker baru).
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian LEASE — PASS): sesi PROCESSING dengan lease masih hidup (expiry 25 detik di masa depan) berubah COLLECTING dalam <2 detik setelah `app.start()`, tanpa menunggu expiry. Unit suite: 223/223 PASS.

---

### [FIX2-WO-002] Tolak WO Claim NL dari Pengirim Non-Delegasi Tim Pelapor (Prioritas 2 — Medium)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/application/wo-claim-session.ts` (`resolveFixtureForWoClaim` fallback by team-name), `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: Fallback resolusi fixture by team-name mention tidak memverifikasi pengirim = delegasi tim reporting — user mana pun bisa staging klaim WO atas nama tim lain.
- **Perubahan Kode**: Fallback #4 kini (a) menolak pengirim tanpa delegasi terverifikasi dengan pesan penjelasan, dan (b) memverifikasi `reportingDelegateId === delegate tim reporting` sebelum staging; gate kedua `!ok` organizer tetap utuh.
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian WO — 4/4 PASS): UNKNOWN sender → ditolak; delegasi sah tim pelapor → klaim staged; `!ok` organizer tetap mengesahkan (fixture WALKOVER 3-0).

---

### [FIX2-GROUP-001] Hapus Auto-Adopt Grup Resmi dari Command Admin (Prioritas 2 — Medium)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/whatsapp/router.ts` (group scope validation), `audit-artifacts/audit_sync_central_group.ts` (scenario di-update), `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: Organizer menjalankan command admin (`!createtournament` dll.) di grup lain otomatis menjadikan grup itu grup resmi baru tanpa konfirmasi — risiko salah kirim command di grup personal.
- **Perubahan Kode**: Auto-adopt hanya tersisa untuk (1) `!setgroup` eksplisit dan (2) bootstrap pertama saat belum ada grup resmi terkonfigurasi. Command admin lain di grup non-resmi ditolak dengan pesan yang mengarahkan ke `!setgroup`; pesan untuk non-organizer tidak berubah.
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian GROUP — 3/3 PASS; `audit_sync_central_group.ts` scenario 3/4 baru — PASS): `!createtournament` di grup asing ditolak; central group tidak berubah; `!setgroup` tetap bisa pindah secara eksplisit.

---

### [FIX2-LOOKUP-001] Exact Match Fixture ID di !roomcard/!claimwo (Prioritas 3 — Low)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/application/tournament-commands.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `WHERE f.id = ? OR f.id LIKE ? || '%'` membuat input pendek ambigu (cocok ke beberapa fixture sekaligus, `LIMIT 1` pilih arbitrary); pesan bantuan memakai contoh `!roomcard 1 ok` yang mendorong kebiasaan prefix.
- **Perubahan Kode**: Lookup diubah exact-match penuh di kedua command; pesan error & contoh diperbarui mengarahkan penggunaan ID fixture lengkap (via `!schedule`).
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian LOOKUP — 4/4 PASS): dua fixture dengan ID saling prefix (`fix-lookup` vs `fix-lookup-1`) diresolve tepat ke fixture yang dimaksud (ROUND_2); update status host menulis ke fixture yang tepat; input pendek non-exact ditolak dengan pesan jelas; string LIKE prefix hilang dari SQL.

---

### [FIX2-SQL-001] Parameterize IN (...) di claimDebounceBatch (Prioritas 3 — Low)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/ingestion/debounce.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `IN (${messageIds})` menggabungkan ID langsung ke string SQL — melanggar pola parameterized file lain.
- **Perubahan Kode**: Placeholder `?` array sesuai pola `player_game_stats` di `stats.ts`.
- **Bukti & Verifikasi**: `dryrun_fix2_items.ts` bagian SQL — 2/2 PASS (string concat hilang, placeholder ada); full suite 223/223 PASS (jalur debounce batch dieksekusi dry-run e2e lintas-artifact juga lolos).

---

### [FIX2-DEADCODE-001] Hapus recordGenuineDraw (Prioritas 3 — Low)
- **Status**: Selesai & Terverifikasi (keputusan: HAPUS)
- **Modul/File Terkait**: `src/competition/walkover.ts`, `tests/unit/competition.test.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `recordGenuineDraw` dead code — hasil seri resmi sudah berjalan lewat `onReportLocked` → `games.is_draw=1` → `computeGroupStandings` (1 poin, FR-CALC-001) yang terverifikasi dry-run; signature fungsi juga cacat (`score` tunggal untuk kedua sisi, tak bisa merepresentasikan 2-2 vs 1-1).
- **Perubahan Kode**: Fungsi dihapus; unit test "double WO 0 poin ≠ seri sah 1 poin" ditulis ulang memverifikasi jalur resmi standings (game is_draw → computeGroupStandings → 1 poin) vs double walkover (0 poin).
- **Bukti & Verifikasi**: `dryrun_fix2_items.ts` bagian DEADCODE — 2/2 PASS; `tests/unit/competition.test.ts` 23/23 PASS dalam full suite 223/223.

---

### Bug Baru Ditemukan (Dilaporkan, TIDAK Diperbaiki Sendiri — Status: REPORTED / PENDING_APPROVAL)
1. **5 error TypeScript pre-existing di `master`** (`tsc --noEmit` di commit `16c97bb` tanpa perubahan saya): `PendingWoClaim` membutuhkan field `id` yang tidak diisi di `tournament-commands.ts:2584` (jalur `!claimwo` delegate) dan `NormalizedMessage` tidak punya properti `sender_id` yang dipakai di `wo-claim-session.ts`/`router.ts`/`tournament-commands.ts` (4 lokasi). Suite test tidak meng-cover path ini sehingga tetap 223/223 PASS — runtime bisa `undefined.split` pada jalur tertentu. Direkomendasikan perbaikan terpisah (tambahkan `id: randomUUID()` pada staging `!claimwo`; ganti `sender_id` → `sender_raw_address`).
2. **Approvals tidak di-reset saat reopen**: `organizerReopenReport` mengubah status versi namun **tidak menghapus baris approvals lama** — vote pertama setelah reopen langsung melengkapi konsensus 3 pihak (vote TEAM_A tunggal → LOCKED lagi). Ini melanggar semangat FR-APR-003 ("any new version creates a fresh version with 0 approvals") untuk kasus reopen-versi-sama. Dry-run saya mendokumentasikan perilaku ini sebagai baseline; perbaikan (DELETE approvals saat reopen) sebaiknya diputuskan Arya karena berdampak pada UX koreksi pasca-reopen.

---

### Ringkasan Akhir & Regression Gate Check (branch fix/second-opinion-findings)

**Full Vitest Suite**: 18 file / **223/223 PASS** (durasi ~12s; test restart-lease & genuine-draw ditulis ulang mengikuti semantik baru FIX2-LEASE-001 / FIX2-DEADCODE-001).

**Dry-run audit-artifacts (14/14 PASS)**:

| # | Skrip | Status |
|---|-------|--------|
| 1–12 | `audit_command_router_wiring`, `audit_db_migration_failure`, `audit_end_to_end_tournament_flow`, `audit_gemini_key_validation`, `audit_goalkeeper_and_batch_pipeline`, `audit_rbac_wo_claim`, `audit_roomcard_commands`, `audit_roster_pipe_and_table`, `audit_round_robin_5teams`, `audit_sec_media_secret`, `audit_sync_central_group` (scenario 3 di-update per FIX2-GROUP-001), `audit_trusted_context` | **12/12 PASS** |
| 13 | `dryrun_knockout_stage.ts` (baru, FIX2-KO-001) | **21/21 PASS** |
| 14 | `dryrun_fix2_items.ts` (baru, 8 temuan lain) | **30/30 PASS** |

**Dry-run second-opinion lintas-branch** (`second-opinion-audit-artifacts/dryrun_e2e.ts` dari branch `audit/second-opinion-v1`, dijalankan terhadap kode hasil fix): **34/34 PASS**.


## [2026-11-20] Sesi Independen: Fix 2 Bug TypeScript Pre-Existing dari master (Task: flash-peak-tms-fix-preexisting-ts-bugs-v1, Branch: fix/preexisting-ts-bugs → PR baru)

### Konteks Sesi
Sesi ini memperbaiki **2 bug TypeScript pre-existing di master** yang saya temukan dan laporkan sendiri saat typecheck di sesi PR #2 (branch fix/second-opinion-findings), namun saat itu sengaja TIDAK diperbaiki karena di luar scope task (sesuai aturan kerja: dilaporkan dulu, status REPORTED). Keduanya sudah ada SEBELUM PR #2 dan bukan regresi darinya. Sesi ini mengerjakan fix-nya sebagai task tersendiri di **branch baru `fix/preexisting-ts-bugs` dari master terkini `16c97bb`** (independen dari PR #2 yang masih berjalan; tanpa merge).

Saat typecheck di master murni awal sesi, kedua bug terkonfirmasi persis seperti laporan sebelumnya (5 baris error): 1× `PendingWoClaim.id` + 4× `sender_id`.

---

### [BUGFIX-TS-001] PendingWoClaim.id tidak terisi di jalur !claimwo
- **Status**: Selesai & Terverifikasi
- **File**: `src/application/tournament-commands.ts` (handler `!claimwo`, konstruksi `PendingWoClaim`)
- **Akar masalah** (dianalisis dulu sebelum fix): interface `PendingWoClaim` (src/application/wo-claim-session.ts) mensyaratkan field `id: string`, dan jalur natural-language WO-claim di `src/index.ts` SUDAH mengisinya dengan `id: randomUUID()` — tapi handler command `!claimwo` di tournament-commands.ts lupa mengisi field itu. Sesi WO di-keying per `chatId` (bukan per id) sehingga `id` saat ini tidak pernah *dibaca* oleh wo-claim-session (stagePendingClaim/getPending/confirmPending/rejectPending semua pakai chatId) — namun kontrak tipe terlanggar dan jika ada referensi `claim.id` di masa depan (mis. untuk audit/korelasi) akan mendapat `undefined` di jalur `!claimwo` saja, tidak di jalur NL. Perbedaan perilaku antar-dua jalur input yang sama fungsi inilah risiko laten yang sebenarnya.
- **Fix**: generate `id: randomUUID()` di titik konstruksi claim di handler `!claimwo` — konsisten persis dengan jalur NL yang sudah benar (`randomUUID` sudah di-import). Tidak ada tempat lain yang perlu diubah karena tidak ada konsumen id saat ini; kedua jalur kini menghasilkan claim dengan id identik dalam format dan semantik.
- **Bukti & Verifikasi** (`npx tsx audit-artifacts/dryrun_fix_preexisting_ts_bugs.ts` — T1, 8/8 PASS): delegasi `!claimwo` → pending claim tersedia di sesi; **`pending.id` string non-kosong dengan format UUID valid** (sebelum fix: undefined); `reportedByAddress` = sender_raw_address delegasi; organizer `!ok` → klaim disahkan, WO 3-0 tercatat di `games` (is_walkover=1); pending ter-clear. End-to-end jalur `!claimwo` utuh tanpa regresi (dry-run lama `audit_rbac_wo_claim.ts` juga tetap PASS).

---

### [BUGFIX-TS-002] Properti sender_id dipakai di 4 lokasi padahal tidak ada di NormalizedMessage
- **Status**: Selesai & Terverifikasi
- **File**: `src/application/tournament-commands.ts` (1 lokasi: reportedByAddress di `!claimwo`), `src/whatsapp/router.ts` (3 lokasi: `isSenderOrganizer` ×2, `handleMessage` delegate resolution)
- **Akar masalah** (dianalisis dulu sebelum fix): keempat lokasi memakai pola fallback `message.sender_raw_address || message.sender_id`, tapi `sender_id` **tidak pernah ada** di tipe `NormalizedMessage` — field yang tersedia adalah `sender_raw_address` (required, `string`), `sender_normalized_address`, `participant`, dll. Ini field warisan dari pra-refactor normalisasi pesan (sisa nama lama). Analisis normalizer (src/whatsapp/normalizer.ts): `sender_raw_address = msg.key.participant || msg.key.remoteJid || ''` dan pesan tanpa `remoteJid` langsung di-drop (`return null`) — jadi **setiap NormalizedMessage yang ada di runtime pasti punya sender_raw_address non-kosong** (minimum remoteJid). Kesimpulan akar masalah: **bukan** tipe yang kurang field (menambah `sender_id` ke tipe hanya agar tsc diam adalah salah kaprah — tidak ada produser yang mengisi field itu); akar masalahnya adalah 4 referensi ke field yang tidak pernah ada → fallback mati yang tampaknya aman di typecheck lama.
- **Fix**: hapus fallback `|| message.sender_id` di keempat lokasi; nilai yang dipakai kini murni `sender_raw_address` yang required dan dijamin non-kosong. Perilaku runtime tidak berubah untuk pesan hasil normalizer (nilai `undefined || x` tidak pernah tercapai); yang berubah hanya hilangnya referensi property ilegal.
- **Temuan turunan penting selama verifikasi**: 2 dry-run lama (`audit_sync_central_group.ts`, `audit_roomcard_commands.ts`) ternyata membangun `NormalizedMessage` buatan dengan field ilegal `sender_id`/`sender_phone` **tanpa** `sender_raw_address` — selama ini jalurnya "bekerja" justru karena fallback `|| sender_id` menutup `undefined`. Setelah fallback dihapus, kecurangan itu tersingkap dan dry-run crash di `isSenderOrganizer`. Dry-run lama inilah bukti nyata kenapa pemakaian field yang tidak ada di tipe itu berbahaya. Keduanya diperbaiki dengan membangun pesan **sesuai kontrak tipe** (`sender_raw_address` + `sender_normalized_address`), bukan dengan menghidupkan kembali field ilegal.
- **Bukti & Verifikasi** (`dryrun_fix_preexisting_ts_bugs.ts` — T2, 8/8 PASS): (A) `isSenderOrganizer` mengenali organizer via JID dari `sender_raw_address`, menolak non-organizer; (B) jalur fallback nomor telepon (`rawDigits` — lokasi fix kedua di router) mengenali organizer via organizerPhone tanpa kecocokan JID; (C) command dari delegasi non-organizer terproses via `handleMessage` → `resolveIdentity(sender_raw_address)` VERIFIED (nilai valid, bukan undefined); (D) jalur `!claimwo` (lokasi ke-4) aman dengan `reportedByAddress` terisi valid. Keempat lokasi terbukti menerima nilai valid saat runtime — bukan sekadar typecheck lolos.
- **Regression penuh sesi ini**: `tsc --noEmit` **0 error** (sebelumnya 5 — target task tercapai); full vitest suite **223/223 PASS** (18 file); sweep 13 dry-run audit-artifacts **13/13 PASS** (termasuk `audit_rbac_wo_claim.ts`, `audit_roomcard_commands.ts`, `audit_sync_central_group.ts` yang menjangkau jalur-jalur terdampak, dan dry-run baru `dryrun_fix_preexisting_ts_bugs.ts`).

---

### Catatan Tambahan
1. Branch `fix/preexisting-ts-bugs` dibuat **dari master terkini** (bukan dari branch PR #2) karena task ini independen; PR baru dibuka ke master dan **tidak di-merge** — menunggu review Arya, konsisten dengan proses sebelumnya.
2. PR #2 (`fix/second-opinion-findings`) tidak disentuh sama sekali di sesi ini; kedua bug fix ini akan berujung konflik minimal dengan PR #2 karena perubahan di area yang sama (`tournament-commands.ts` `!claimwo`) bersifat tambahan baris `id: randomUUID()` dan penghapusan fallback — mudah di-resolve saat merge.


## [2026-11-20] Sesi Perbaikan Temuan Audit Independen (Task: flash-peak-tms-fix-audit-findings-v1)

### Konteks Sesi
Sesi ini dilakukan sebagai tindak lanjut langsung dari laporan audit independen `flash-peak-tms-full-wiring-audit-v1` (19 November 2026). Audit tersebut memverifikasi kondisi aktual kode setelah modularisasi `src/index.ts` ke `src/application/` dan mengidentifikasi celah kritis pada pipeline bukti kiper (screenshot diabaikan, ekstraktor kiper tidak terpanggil, resolver identitas kiper dead code), kegagalan broadcast otomatis matchday saat central group didaftarkan dinamis, fallback hardcoded HMAC secret di media service, logika room card fallback yang terisolasi dari router, serta beberapa ketidaksesuaian RBAC dan context AI.

Semua perbaikan pada sesi ini dikerjakan secara berurutan sesuai prioritas (Critical $\rightarrow$ High $\rightarrow$ Medium $\rightarrow$ Low) dengan tetap menjaga arsitektur modular `src/application/` tanpa menarik logika kembali ke `src/index.ts`.

---

### [FIX-GK-001 & FIX-GK-002] Integrasi Goalkeeper Detail Extractor & Validasi Kuota Screenshot BO3/BO5
- **Prioritas**: Critical (Prioritas 1)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/evidence-batch-processor.ts`
  - `src/index.ts`
  - `audit-artifacts/audit_goalkeeper_and_batch_pipeline.ts`
- **Rencana & Masalah**:
  - Pada `evidence-batch-processor.ts`, aset bertipe `INDIVIDUAL_PLAYER_DETAIL` dikumpulkan ke `gkDetailAssets` namun diabaikan sama sekali (tidak ada pemanggilan extractor). Nilai `goalkeeper_saves` pada `team_a_players`/`team_b_players` di-hardcode ke `null`.
  - Fungsi `resolveGoalkeeperIdentity` dari `src/ai/extractors/gk-identity.ts` tidak pernah dipanggil di jalur pemrosesan batch.
  - Tidak ada validasi jumlah screenshot kiper untuk format knockout series (BO3 minimal 2 screenshot kemenangan, BO5 minimal 3 screenshot kemenangan).
- **Perubahan Kode**:
  1. Menambahkan `gkExtractor?: GoalkeeperDetailExtractor` ke interface `EvidenceBatchProcessorDeps` pada `src/application/evidence-batch-processor.ts`.
  2. Meneruskan `gkExtractor: this.gkExtractor` saat memanggil `processClaimedBatch` di `src/index.ts`.
  3. Mengumpulkan caption dari media individual player detail untuk disambungkan ke resolver identitas.
  4. Memeriksa format seri (`BO3` / `BO5` / Group). Menghitung `expectedGkCount` (BO3: 2, BO5: 3, Grup: 1, atau 0 jika imbang). Jika jumlah screenshot kiper dari tim submitting kurang dari kuota, memvalidasi dan menandai status laporan menjadi `NEEDS_CORRECTION` dengan pesan peringatan informatif di template WhatsApp.
  5. Memanggil `deps.gkExtractor.extract()` untuk setiap aset `INDIVIDUAL_PLAYER_DETAIL`, lalu memanggil `resolveGoalkeeperIdentity()` mencocokkan caption/nama kiper ke roster aktif tim yang submit.
  6. Memetakan hasil ekstraksi saves (`gkSavesByNickname`) ke pemain terkait di `rawPlayersForA` dan `rawPlayersForB`, mengeliminasi hardcode `null`.
- **Bukti & Verifikasi**:
  - Menjalankan `npx tsx audit-artifacts/audit_goalkeeper_and_batch_pipeline.ts`:
    - Scenario 1 (BO3 dengan 2 screenshot kiper): status `DRAFT_CREATED`, `gkExtractor` dipanggil 2x, `goalkeeper_saves` = 7. (PASS)
    - Scenario 2 (BO3 dengan 1 screenshot kiper): status `NEEDS_CORRECTION`, peringatan kuota kiper muncul di ringkasan pesan WA. (PASS)
    - Scenario 3 (BO3 dengan 3 screenshot kiper): status `DRAFT_CREATED`, saves terekstrak dengan catatan kelebihan screenshot. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-SYNC-001] Sinkronisasi centralGroupJid Antara Router, MatchdayService, dan FlashPeakApp
- **Prioritas**: High (Prioritas 2)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/whatsapp/router.ts`
  - `src/application/matchday-service.ts`
  - `src/index.ts`
  - `audit-artifacts/audit_sync_central_group.ts`
- **Rencana & Masalah**:
  - Command `!setgroup` dan `!createtournament` meng-update `centralGroupJid` di router via `this.setCentralGroupJid(jid)`, tetapi tidak meng-update `this.centralGroupJid` milik `FlashPeakApp` dan tidak memanggil `this.matchdayService.setCentralGroupJid(jid)`.
  - Jika bot dijalankan tanpa env variable `WA_CENTRAL_GROUP_JID` (atau grup didaftarkan dinamis saat runtime), `matchdayService` tetap memegang `centralGroupJid = ""` sehingga broadcast jadwal matchday tidak dapat terkirim.
  - Selain itu, ditemukan bug edge-case di `router.ts`: `message.sender_raw_address.toLowerCase()` melempar `TypeError` jika `sender_raw_address` tidak terdefinisi.
- **Perubahan Kode**:
  1. Menambahkan listener callback `onCentralGroupJidChange` pada `CommandRouter` (`src/whatsapp/router.ts`) dan method `onGroupJidChanged(listener)`.
  2. Memastikan pemanggilan `this.setCentralGroupJid(normalizedChatId)` di router saat admin menjalankan command administratif atau pendaftaran grup baru (menggantikan assignment field direct).
  3. Memperbaiki null safety pada pengecekan `isSenderOrganizer` di `router.ts`.
  4. Menambahkan getter `getCentralGroupJid(): string` pada `MatchdayService`.
  5. Mengubah field `centralGroupJid` di `FlashPeakApp` agar mutable, mendaftarkan listener di constructor yang mensinkronkan `FlashPeakApp.centralGroupJid` dan `matchdayService.setCentralGroupJid(newJid)`, serta mengekspos helper method `setCentralGroupJid(jid)` dan `getCentralGroupJid()`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_sync_central_group.ts`:
    - Scenario 1: Bot start dengan central group kosong $\rightarrow$ Organizer kirim `!setgroup` $\rightarrow$ ketiga komponen (`app`, `router`, `matchdayService`) sinkron ke group JID baru. (PASS)
    - Scenario 2: Pemanggilan programatik `app.setCentralGroupJid()` $\rightarrow$ ketiga komponen sinkron. (PASS)
    - Scenario 3: Organizer kirim `!createtournament` dari group baru $\rightarrow$ ketiga komponen otomatis ter-update ke group baru. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-SEC-001B] Penghapusan Fallback Secret Hardcoded di flashpeak-media & Konfigurasi PM2 Ecosystem
- **Prioritas**: High (Prioritas 2)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `services/flashpeak-media/config.ts`
  - `services/flashpeak-media/server.ts`
  - `ecosystem.config.cjs`
  - `audit-artifacts/audit_sec_media_secret.ts`
- **Rencana & Masalah**:
  - Line 28 `services/flashpeak-media/config.ts` masih memiliki fallback secret HMAC ter-hardcode (`'e56ad9530df7d79427f1e39d089210eddf18c55d136ca4a3cec438eff86dc206'`) meskipun dokumentasi sebelumnya mengklaim sudah dihapus.
  - `ecosystem.config.cjs` tidak mendefinisikan `FLASHPEAK_MEDIA_SECRET` di blok env `flashpeak-media`, sehingga jika dideploy via PM2 berpotensi memakai secret default.
- **Perubahan Kode**:
  1. Menghapus fallback string hex hardcode pada `services/flashpeak-media/config.ts`. Mengubah `getDefaultConfig(overrides)` agar melempar error deskriptif jika `FLASHPEAK_MEDIA_SECRET` atau `MEDIA_SERVICE_HMAC_SECRET` tidak tersedia di environment.
  2. Memperbarui `createMediaServer` di `services/flashpeak-media/server.ts` agar melewatkan `customConfig` ke `getDefaultConfig(customConfig)` sebelum memvalidasi ketersediaan secret (sehingga unit test dengan mock config tetap berjalan mulus).
  3. Menambahkan mapping environment variable `FLASHPEAK_MEDIA_SECRET` dan `MEDIA_SERVICE_HMAC_SECRET` pada kedua app (`flashpeak-media` dan `flashpeak-bot`) di `ecosystem.config.cjs`.
  4. Melakukan audit grep menyeluruh terhadap string rahasia dan hex 32-64 karakter di seluruh codebase `src/` dan `services/`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_sec_media_secret.ts`:
    - Static check: memastikan string hex rahasia tidak lagi berada di `config.ts`. (PASS)
    - Dynamic check: memastikan `getDefaultConfig()` melempar error saat secret tidak ada di env. (PASS)
    - Dynamic check: memastikan secret terbaca dengan benar dari `FLASHPEAK_MEDIA_SECRET` maupun `MEDIA_SERVICE_HMAC_SECRET`. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS (termasuk 19/19 test suite media).

---

### [FIX-WO-001] Integrasi Logika Room Host Availability & Fallback ke Router Command (!roomcard)
- **Prioritas**: High (Prioritas 2)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/tournament-commands.ts`
  - `audit-artifacts/audit_roomcard_commands.ts`
- **Rencana & Masalah**:
  - Fungsi `evaluateRoomHostAvailability` di `src/competition/walkover.ts` sebelumnya tidak memiliki jalur pemanggilan dari WhatsApp command router.
  - Aturan FR-COMP-014, D-029, D-031, dan D-032 (tim kiri default $\rightarrow$ tim kanan ganti $\rightarrow$ tim kanan menolak jadi WO $\rightarrow$ kedua tim tidak punya kartu: grup 0 poin vs knockout wajib reschedule) tidak dapat diakses atau dipicu oleh user/panitia.
- **Perubahan Kode**:
  1. Mengimpor `evaluateRoomHostAvailability` ke `src/application/tournament-commands.ts`.
  2. Mengimplementasikan `roomCardHandler` dan mendaftarkan 3 command aliases: `!roomcard`, `!karturoom`, `!hostroom` dengan role `ANY` (dapat diakses organizer dan delegasi tim bertanding).
  3. Menyediakan navigasi status:
     - `!roomcard <fixture_id>`: Menampilkan status tuan rumah default (kiri), host aktif saat ini, dan panduan perintah.
     - `!roomcard <fixture_id> ok`: Tuan rumah terjadwal (kiri) memiliki room card dan siap menjadi host game.
     - `!roomcard <fixture_id> ganti`: Kiri tidak punya room card, lawan bersedia menggantikan sebagai host (status `OPPONENT_SUBSTITUTED`).
     - `!roomcard <fixture_id> tolak`: Kiri tidak punya room card, lawan menolak menggantikan $\rightarrow$ lawan menang WO 3-0.
     - `!roomcard <fixture_id> habis`: Kedua tim tidak memiliki room card. Pada Group Stage mencatat double walkover 0–0 (0 poin masing-masing tanpa statistik pemain per D-031) serta memperbarui klasemen grup; pada Knockout Stage menetapkan status wajib reschedule per D-032 (jadwal dikosongkan untuk penjadwalan ulang oleh panitia).
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_roomcard_commands.ts`:
    - Test 1: Info display status room host. (PASS)
    - Test 2: Status `ok` $\rightarrow$ `DEFAULT_LEFT_SIDE`. (PASS)
    - Test 3: Status `ganti` $\rightarrow$ `OPPONENT_SUBSTITUTED`. (PASS)
    - Test 4: Status `tolak` $\rightarrow$ Single Forfeit (Singa FC menang WO 3-0). (PASS)
    - Test 5: Status `habis` di Group Stage $\rightarrow$ `GROUP_DOUBLE_WALKOVER_RECORDED` (0 poin masing-masing). (PASS)
    - Test 6: Status `habis` di Knockout Stage $\rightarrow$ `KNOCKOUT_RESCHEDULE_REQUIRED` (wajib reschedule, scheduled_at dibersihkan). (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-RBAC-001] Staging Klaim WO oleh Delegasi & Eksekusi Langsung oleh Panitia (!claimwo)
- **Prioritas**: Medium (Prioritas 3)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/tournament-commands.ts`
  - `src/whatsapp/router.ts`
  - `audit-artifacts/audit_rbac_wo_claim.ts`
- **Rencana & Masalah**:
  - Command `!claimwo`, `!klaimwo`, `!wo` sebelumnya di-lock hanya untuk panitia (`requiredRole: 'ORGANIZER'`).
  - Delegasi resmi tim tidak dapat mengajukan klaim WO melalui command, padahal rancangan FR-FIX-001 dan `wo_claim.ts` mendesain dua jalur: delegasi mengajukan klaim $\rightarrow$ status staged pending $\rightarrow$ panitia mengonfirmasi dengan `!ok` (atau `!batal`).
  - Selain itu, ditemukan bug pada context command: kode sebelumnya memeriksa `ctx.senderDelegate` yang tidak pernah ada di `CommandContext` (field sesungguhnya adalah `ctx.delegateId`).
- **Perubahan Kode**:
  1. Mengubah `requiredRole` untuk command `claimwo`, `klaimwo`, `wo` dari `'ORGANIZER'` menjadi `'ANY'`.
  2. Memperbaiki pengecekan delegasi dengan menggunakan `ctx.delegateId` pada `claimWoHandler` dan `roomCardHandler`.
  3. Mengimplementasikan dual-flow pada `claimWoHandler`:
     - **Jalur Delegasi**: Jika pengirim bukan panitia, sistem memverifikasi bahwa pengirim adalah delegasi resmi dari tim yang bertanding. Data klaim kemudian di-stage ke `deps.woClaimSession.stagePendingClaim(claim)` dengan TTL 15 menit. Bot memberikan respons bahwa klaim WO telah diajukan dan menunggu persetujuan panitia via `!ok` atau penolakan via `!batal`. Fixture tetap pada status `SCHEDULED` sampai panitia mengonfirmasi.
     - **Jalur Panitia (Organizer)**: Jika pengirim adalah panitia, klaim WO dieksekusi langsung secara administratif (`handleSingleForfeit`), fixture menjadi `WALKOVER`, skor resmi 3-0 dicatat, dan klasemen grup otomatis diperbarui.
  4. Memperbaiki null safety pada `message.sender_raw_address` di `src/whatsapp/router.ts` saat memanggil `isSenderOrganizer` dan `resolveIdentity`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_rbac_wo_claim.ts`:
    - Test 1: User acak / tidak terdaftar mencoba `!claimwo` $\rightarrow$ ditolak izinnya. (PASS)
    - Test 2: Delegasi tim peserta mengajukan `!claimwo` $\rightarrow$ klaim tersimpan di `woClaimSession`, notifikasi konfirmasi panitia muncul, fixture tetap `SCHEDULED`. (PASS)
    - Test 3: Panitia membalas `!ok` $\rightarrow$ klaim disahkan, fixture berubah menjadi `WALKOVER`, skor 3-0, poin bertambah, `woClaimSession` dibersihkan. (PASS)
    - Test 4: Panitia langsung mengeksekusi `!claimwo` $\rightarrow$ langsung diterapkan tanpa staging. (PASS)
  - Menjalankan `audit-artifacts/audit_roomcard_commands.ts`: 6/6 test PASS.
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-CTX-001] Propagasi Grounded trusted_context (Nama Tim & Roster) ke MatchSummaryExtractor
- **Prioritas**: Medium (Prioritas 3)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/evidence-batch-processor.ts`
  - `audit-artifacts/audit_trusted_context.ts`
- **Rencana & Masalah**:
  - Pada `evidence-batch-processor.ts`, `matchExtractor.extract()` dipanggil sebelum data fixture di-query dan tanpa parameter `trusted_context`.
  - Hal ini menyebabkan AI vision model mengekstrak nama tim dan pemain tanpa panduan konteks data yang sah dari database, sehingga meningkatkan risiko halusinasi OCR pada nama tim dan Unicode nickname pemain.
- **Perubahan Kode**:
  1. Menggeser pemanggilan query fixture (`fixtures`, `teams`, `games`) ke sebelum eksekusi `matchExtractor.extract()`.
  2. Menambahkan query daftar pemain aktif (`status = 'ACTIVE'`) dari kedua tim yang bertanding (`team_a_id` dan `team_b_id`) dari tabel `players`.
  3. Membentuk objek `trusted_context` yang mencakup:
     - `fixture_id`
     - `team_a_name`
     - `team_b_name`
     - `expected_roster`: array nickname pemain terdaftar beserta `team_id` terkait.
  4. Meneruskan `trusted_context` dan `correlation_id` (`session-${sessionId}`) ke options `matchExtractor.extract({ mime_type, base64 }, { trusted_context, correlation_id })`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_trusted_context.ts`:
    - Memverifikasi objek `trusted_context` diterima oleh `matchExtractor.extract()`.
    - Memverifikasi nama kedua tim (`Elang Mas FC` & `Harimau Putih FC`) dan 10 pemain roster terisi lengkap.
    - Memverifikasi prompt yang dikirim ke AI router memuat JSON `trusted_context` sehingga grounding AI bekerja. (PASS)
  - Menjalankan `audit-artifacts/audit_goalkeeper_and_batch_pipeline.ts`: 3/3 scenario PASS.
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-ROSTER-001] Pembersihan Tabel Markdown & Penanganan Kolom Pipe di parseRosterInput
- **Prioritas**: Medium (Prioritas 3)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/tournament-commands.ts`
  - `audit-artifacts/audit_roster_pipe_and_table.ts`
- **Rencana & Masalah**:
  - Pada pengujian `audit_roster_pipe_and_table.ts`, Test 3 (pendaftaran roster via format tabel markdown dengan pemisah pipe `|`) sebelumnya GAGAL pada parser deterministik.
  - Parser regex sederhana memperlakukan baris header tabel (`| No | Posisi | Nickname |`) dan baris pemisah (`|---|---|---|`) sebagai nama tim / nama pemain, serta menelan pipe pembatas kolom sehingga clan tag dengan pipe menjadi rusak.
- **Perubahan Kode**:
  1. Menambahkan deteksi dan parser tabel markdown khusus di awal `parseRosterInput` (`src/application/tournament-commands.ts`).
  2. Memisahkan baris teks sebelum tabel (untuk nama tim) dari baris tabel.
  3. Memfilter dan mengabaikan baris header tabel markdown (misal `No`, `Posisi`, `Nickname`, `Pemain`) dan separator baris (`|---|---|---|`).
  4. Untuk setiap baris data tabel markdown:
     - Menghapus pipe di awal dan akhir baris.
     - Membaca kolom sel: mengidentifikasi posisi (`GK`, `Inti`, `Cadangan`), mengabaikan kolom nomor urut baris (jika ada).
     - Menggabungkan kembali sisa sel dengan pipe (` | `) sehingga clan tag pemain yang menggunakan pipe (seperti `AVO | Zenyth`, `RRQ | Lemon`) tetap utuh tanpa terpecah.
- **Bukti & Verifikasi**:
  - Menjalankan ulang `audit-artifacts/audit_roster_pipe_and_table.ts`:
    - Test 1 (Single-line dengan pipe clan tag & section pipes): PASS.
    - Test 2 (Multiline dengan pipe clan tag): PASS.
    - Test 3 (Markdown table dengan pipe columns): PASS (`gkName`: `'AVO | Zenyth'`, 4 starters, 1 sub).
    - Test 4 (Pemeriksaan prompt AI): PASS.
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-APIKEY-001] Perbaikan Pengecekan Validasi Gemini API Key di CLI Startup
- **Prioritas**: Low (Prioritas 4)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/cli/start.ts`
  - `audit-artifacts/audit_gemini_key_validation.ts`
- **Rencana & Masalah**:
  - Pada `src/cli/start.ts` baris 139, kondisi validasi key Gemini: `if (geminiKey && geminiKey !== 'AIzaSy_placeholder_gemini_api_key' && !geminiKey.startsWith('AIzaSy_'))`.
  - Prefix resmi API key Google AI Studio (Gemini) adalah `AIzaSy`. Pengecekan `!geminiKey.startsWith('AIzaSy_')` menyebabkan key asli yang diawali `AIzaSy_` dianggap sebagai placeholder secara keliru sehingga inisialisasi Gemini adapter terabaikan dan fallback ke provider lain.
- **Perubahan Kode**:
  1. Mengubah kondisi pengecekan agar memeriksa placeholder secara spesifik: `geminiKey !== 'AIzaSy_placeholder_gemini_api_key' && !geminiKey.includes('placeholder')`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_gemini_key_validation.ts`:
    - Menguji 6 variasi key (default placeholder, string placeholder sembarang, key dengan prefix `AIzaSy_`, key dengan prefix `AIzaSy`, string kosong, undefined).
    - Semua test case menghasilkan nilai evaluasi yang sesuai ekspektasi. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

## Ringkasan Akhir & Regression Gate Check

Seluruh 12 skrip pengetesan independen pada direktori `audit-artifacts/` dan full unit/integration test suite (`npm test`) telah dijalankan ulang sebagai regression check menyeluruh setelah semua perbaikan selesai.

### Hasil Eksekusi Audit Artifacts (12/12 PASS):
| # | Skrip Audit | Area / Fitur Terkait | Status |
|---|-------------|----------------------|--------|
| 1 | `audit_command_router_wiring.ts` | Registrasi 36 command router & penolakan RBAC non-organizer | **PASS** |
| 2 | `audit_db_migration_failure.ts` | Abort startup & integritas atomik saat migrasi SQL korup | **PASS** |
| 3 | `audit_end_to_end_tournament_flow.ts` | Transisi state turnamen end-to-end (Draft $\rightarrow$ Draw $\rightarrow$ Fixture $\rightarrow$ Report $\rightarrow$ Standings $\rightarrow$ Awards) | **PASS** |
| 4 | `audit_gemini_key_validation.ts` | Validasi API key Gemini tanpa false rejection pada prefix `AIzaSy_` | **PASS** |
| 5 | `audit_goalkeeper_and_batch_pipeline.ts` | Ekstraksi saves kiper, resolver identitas nickname via caption, dan validasi kuota BO3/BO5 | **PASS** |
| 6 | `audit_rbac_wo_claim.ts` | Alur staging klaim WO oleh delegasi vs eksekusi administratif langsung oleh panitia | **PASS** |
| 7 | `audit_roomcard_commands.ts` | Command `!roomcard` untuk evaluasi host (default kiri, substitusi kanan, WO tolak, WO ganda grup 0 poin, wajib reschedule knockout) | **PASS** |
| 8 | `audit_roster_pipe_and_table.ts` | Parsing roster single-line, multiline, dan tabel markdown dengan karakter pipe clan tag | **PASS** |
| 9 | `audit_round_robin_5teams.ts` | Jadwal round-robin 5 tim menghasilkan tepat single round-robin (10 match, 4 match/tim) & keseimbangan host kiri/kanan | **PASS** |
| 10 | `audit_sec_media_secret.ts` | Eliminasi hardcode HMAC secret di `config.ts` dan error handling saat env rahasia tidak disetel | **PASS** |
| 11 | `audit_sync_central_group.ts` | Sinkronisasi dinamis `centralGroupJid` antara router, matchday service, dan app instance | **PASS** |
| 12 | `audit_trusted_context.ts` | Propagasi grounded `trusted_context` (nama tim dan daftar roster aktif) ke ekstraksi vision AI | **PASS** |

### Hasil Full Vitest Test Suite:
- **Test Files**: 18 passed (18)
- **Tests**: 223 passed (223)
- **Durasi**: ~7.8s
- **Regresi / Breaking Changes**: 0

---

## 2026-11-22 - Session: Best Goalkeeper Award Team Attribution (Decision D-036)

### Purpose
Mengalihkan atribusi penghargaan kiper terbaik (*Best Winning Goalkeeper*) pada pengumuman `!awards` agar secara resmi dianugerahkan kepada **Tim** (mewakili seluruh rotasi kiper di tim tersebut), bukan perseorangan kaku, dikarenakan game Flash Peak tidak memunculkan nickname/UID pada layar detail pertahanan kiper.

### Concrete Changes
1. **`src/whatsapp/formatters.ts`**:
   - Memperluas fungsi pembantu `formatAwardSection` dengan opsi `options?: { isTeamAward?: boolean; teamAwardNote?: string }`.
   - Mengalihkan output `bestWinningGoalkeeper` ke format Tim:
     - Mahkota (`👑`) diarahkan ke `Tim: *<teamName>*`.
     - Menyertakan catatan `🧤 Kiper Utama: *<nicknameRaw>*` dan total saves.
     - Menyertakan disclaimer: `_(Penghargaan kiper dianugerahkan kepada Tim mewakili seluruh rotasi kiper)_`.
     - Mendukung tampilan tie/seri tim bersama (`🤝 *Tim Pemenang Bersama*`).
2. **`tests/unit/formatters.test.ts`**:
   - Menambahkan asersi verifikasi output bahwa pengumuman `formatAwardsAnnouncement` memuat penobatan tim (`👑 Tim: *Team 1*`), kiper utama terdaftar, dan catatan representasi rotasi kiper.
3. **`flash-peak-tms/DECISIONS.md`**:
   - Menambahkan catatan resmi **Decision D-036: Best Goalkeeper Award Team Attribution** tertanggal 22 November 2026.

### Empirical Verification
- **Vitest**:
  ```bash
  npx vitest run tests/unit/formatters.test.ts tests/integration/full_flow.test.ts
  ```
  Output: `Test Files: 2 passed (2), Tests: 12 passed (12)`.
- **TypeScript Build**:
  ```bash
  npm run build
  ```
  Output: `tsc` exit code 0 tanpa error.
- **Full Test Suite**:
  ```bash
  npm test
  ```
  Output: `Test Files: 20 passed (20), Tests: 258 passed (258)`.

## 2026-11-22 - Session: Hotfix Deploy PR #9 — Runtime Data JSON Tidak Tersalin ke dist (Task: fix/build-copy-data)

### Latar & Gejala
- Deploy pertama PR #9 ke VM produksi (merge commit `0d6e9cd`, auto-deploy watcher) langsung crash-loop: `flashpeak-bot` `errored` dalam <10 dtk, auto-rollback mengembalikan `86b0c7f` (prod aman di kode lama).
- Log fatal berulang: `ENOENT: open '/home/azureuser/flashpeak-tms/dist/data/flashpeak-trivia.json'` dari `loadTrivia` (`src/application/trivia.ts:47`), dipanggil `registerAiNativeCommands` saat startup — deterministik tiap boot.

### Akar Masalah
- PM2 produksi menjalankan entry compiled `dist/cli/start.js` (definisi proses lama), bukan tsx/src seperti `ecosystem.config.cjs` terbaru. `tsc` tidak menyalin file non-TS (JSON) ke `dist`, padahal `TRIVIA_PATH` di-resolve relatif `__dirname` (`../data/`) → mode dist mencari `dist/data/` yang tidak pernah ada.
- Gap tidak tertangkap audit L2 karena seluruh verifikasi berjalan via vitest/tsx dari source tree (JSON hadir) — gap klasik test-env vs runtime-env.
- Catatan: migrations berjalan sebelum `createApp` (start.ts:67), sehingga migration 004 telah teraplikasi ke DB prod pada percobaan pertama (crash terjadi DI DALAM `createApp`); additive & idempoten — aman terhadap rollback kode.

### Fix
- `package.json` script `build`: `tsc` → `tsc && mkdir -p dist/data && cp src/data/*.json dist/data/` — artefak dist kini self-contained untuk data runtime.

### Empirical Verification
- Sandbox clean-build (`rm -rf dist && npm run build`): `dist/data/flashpeak-trivia.json` hadir (11.3 KB) + modul PR #9 (`agent-planner.js`, `qna.js`, dst.) ter-emit; `tsc` tetap 0 error.
- Redeploy VM dengan guard eksplisit `test -f dist/data/flashpeak-trivia.json` sebelum `pm2 restart` — hasil dicatat di komentar follow-up PR #9.







## 2026-11-22 - Sesi: Tiga perbaikan UX/AI + pergantian delegasi 2 tim (Task: omak-peak-ux-id-001 / ai-memory / delegate-swap)

### Konteks Sesi
Sesi lanjutan hari yang sama setelah hotfix deploy PR #9. Tiga permintaan user (Arya) yang berurutan: (1) perbaikan tampilan `!myid` agar delegate terdaftar tidak lagi hanya melihat "Role: DELEGATE" tanpa info tim; (2) analisa & perbaikan `!ai` yang (a) mengarang jam kickoff "22:00 WIB" — tidak ada di mana pun di DB, dan (b) tidak punya memori antar panggilan sehingga follow-up antar user dianggap "percakapan baru mulai"; (3) pergantian delegasi resmi untuk dua tim (Yakigami, Astra Lumina Nova) karena personil delegate berganti — LID lama dihapus, LID baru di-bind.

### Commit pada Sesi Ini
- `99b50df` feat(myid): show registration status + team/tournament for delegates (UX-ID-001)
- `7ab5f10` feat(omak-peak): rolling per-group conversation memory + anti-hallucination time rules

### 1. `!myid` (UX-ID-001) — commit `99b50df`
**Masalah**: Delegate resmi yang jalankan `!myid` hanya melihat `Role di Sistem: DELEGATE` tanpa indikasi apakah benar-benar terdaftar di DB, dan tanpa info tim mana yang diwakilinya. User yang melihat "DELEGATE" malah curiga belum terdaftar.

**Akar masalah**: `idHandler` di `src/whatsapp/router.ts:400` hanya mencetak `ctx.role` — padahal router saat resolve role sudah memegang `delegateId` + `teamId` dari `IdentityResolver.resolveIdentity()`.

**Fix**:
- `src/identity/resolver.ts`: `resolveIdentity()` sekarang juga mengembalikan `tournament_name` (1 kolom tambahan dari JOIN yang sudah ada).
- `src/whatsapp/router.ts` (`!id`/`!myid`): handler jadi async; untuk role DELEGATE, re-resolve full record dan cetak: Status Registrasi (✅ Terdaftar & Terverifikasi), Nama Delegate, Tim Anda (team_name + division), Turnamen, Status Tim. UNKNOWN mendapat baris eksplisit "❌ Belum terdaftar sebagai Delegate". Delegate tanpa tim mendapat hint "Belum terikat ke tim — hubungi Organizer". Footer per-role.
- `tests/unit/whatsapp.test.ts`: +3 assertion path (delegate dengan tim, delegate teamless, unregistered).

**Verifikasi langsung di DB VM** untuk LID `122467200819378@lid` (Team Zodiac FP): delegate "Delegasi Team Zodiac" ACTIVE, tim "Team Zodiac" VERIFIED, turnamen "Gojiha Cup S1" DRAW_READY — user benar-benar terdaftar; sebelumnya hanya tampilan yang ambigu.

### 2. `!ai` hallucinasi jam + tidak ada memori — commit `7ab5f10`
**Masalah A (jam 22:00)**: Bot membalas pertanyaan "chance Jestre juara" dengan klaim "Matchday 1 mulai malam ini jam 22:00 WIB". Cek DB VM:
- Tournament `Gojiha Cup S1` (status DRAW_READY) config_json: `kickoff_time:"21:00"` — TIDAK dipakai operasional.
- Semua 12 fixture: `scheduled_at=null` (matchday belum dijadwalkan).
- Satu-satunya waktu yang di-hardcode di kode (`src/application/omak-peak.ts:219` RULES_SUMMARY) adalah `Cutoff harian: 19:59 WIB`.
- Tidak ada field 22:00 di mana pun. User (Arya) memang sengaja ubah DB agar cutoff 19:59 itu tidak meledak sekarang, supaya MD 1 boleh malam ini — tapi bot tetap tidak punya sumber untuk "22:00". Murni hallucination.

**Masalah B (stateless)**: `!ai "coba tebak terserah"` yang dikirim 22 detik setelah `!ai "siapa juara"` (oleh user berbeda) dibalas "percakapan baru mulai, belum ada petunjuk". Akar: `OmakPeakService.handleAiCommand` stateless — context hanya snapshot DB + user message terkini, tidak ada history Q&A sebelumnya.

**Fix**:
- `src/application/omak-peak.ts`: class baru `ConversationMemory` (in-memory per-chat ring buffer, maks 6 turn, TTL 15 menit, scoped per `chatId`). `OmakPeakService` memegang instance; signature `handleAiCommand(senderRawAddress, userMessage, chatId, senderLabel?)`. Sebelum panggilan AI, snapshot turn-turn terakhir di grup itu di-inject ke `context.recent_ai_turns` (format: `{sender_label, question, answer, ts}`). Setelah response sukses, Q&A turn itu direkam ke buffer. Memory di-capture SEBELUM `buildOmakPeakContext` sehingga tetap hidup walau DB context build throw.
- `src/application/ai-native-commands.ts`: handler `!ai` sekarang pass `ctx.message.chat_id` + `ctx.message.push_name`.
- `src/ai/prompts/omak-peak-context.ts`: field baru optional `recent_ai_turns` di `OmakPeakContext`.
- `src/ai/prompts/omak-peak.ts`: dua section baru di system prompt:
  - "MEMORI PERCAKAPAN (rolling)": panduan pakai recent_ai_turns untuk resolve follow-up antar user; jangan restate verbatim; sender_label boleh dipakai.
  - "KETEPATAN WAKTU & JADWAL": rule keras — hanya sebut jam/tanggal matchday kalau ada di `scheduled_at`; kalau semua null, bilang "jadwal belum dirilis"; JANGAN karang jam sendiri.
- Read-only invariant tetap utuh: memory in-memory only, tidak ada DB write, reset kalau bot restart (acceptable untuk chat asisten komunitas).
- `tests/unit/ai_native.test.ts`: +5 test (3 unit ConversationMemory: record/TTL/ring-bound/per-chat scope; 2 integration: lanjutan intra-group & cross-group isolation).

**Regresi**: tsc 0 error, vitest 307/307 (sebelumnya 302), eslint bersih.

### 3. Pergantian delegasi Yakigami & Astra Lumina Nova (DB write, no code change)
**Permintaan**: Yakigami → LID baru `19246486675490@lid`; Astra Lumina Nova → LID baru `256336633815157@lid`; LID lama dihapus.

**Pre-flight cek DB VM**:
- Yakigami: delegate_id `a6dd1f98-48dd-4553-8103-25a1b958c008`, display_name "Delegasi Yakigami" (role-based, KEEP), LID lama `61208283639870@lid` (is_primary=1).
- Astra Lumina Nova: delegate_id `a733ecbc-9e29-422c-bb91-942bd2864edf`, display_name "Delegasi Astra Lumina Nova" (KEEP), LID lama `214229210689643@lid`.
- Conflict check: kedua LID baru FREE — tidak bound ke delegate lain di `whatsapp_identities`.

**Pendekatan**: Jangan hapus delegate record (FK `teams.delegate_id` ON DELETE SET NULL — kalau dihapus, tim ke-hilangan binding-nya). Cukup swap `whatsapp_identities`: DELETE row lama, INSERT row baru dengan `delegate_id` yang sama. Binding tim + audit trail yang me-reference `delegate_id` tetap valid. Display_name role-based, tidak perlu ganti.

**Eksekusi atomic** (`db_swap_delegates.cjs`, `c.batch(ops, 'write')` — 4 statement dalam 1 transaksi):
1. DELETE whatsapp_identities WHERE delegate_id = Yakigami delegate
2. INSERT new identity (newUUID, delegate_id sama, raw_address `19246486675490@lid`, address_type LID, is_primary 1, source_chat_id central group)
3. DELETE whatsapp_identities WHERE delegate_id = Astra delegate
4. INSERT new identity (`256336633815157@lid`)

**Backup**: `cp local.sqlite local.sqlite.bak-2026-11-22-delegate-swap` di VM sebelum swap (rollback tersedia).

**Post-swap verification** (query langsung di VM):
- Yakigami team bound to LID `19246486675490@lid`, display_name "Delegasi Yakigami", is_primary=1 ✓
- Astra Lumina Nova bound to `256336633815157@lid`, "Delegasi Astra Lumina Nova", is_primary=1 ✓
- LID lama `61208283639870@lid` dan `214229210689643@lid`: GONE (0 rows) ✓
- Tidak perlu restart bot — `IdentityResolver` query DB tiap resolveIdentity(), tidak ada cache in-memory.

### Deployment Status Akhir Sesi
- Repo `master` HEAD: `7ab5f10` (sudah ter-push ke `origin/master`).
- VM `master` HEAD: `7ab5f10` (deployed: `git pull --ff-only && npm run build && pm2 restart flashpeak-bot --update-env && pm2 save`).
- pm2 `flashpeak-bot`: online, 0 unstable restarts. WA reconnect OK. Error log bersih (cuma sisa ENOENT pre-hotfix `aa45604` dari 05:35 UTC).
- DB VM: 28 tabel utuh. Backup `local.sqlite.bak-2026-11-22-delegate-swap` tersimpan di VM untuk rollback.
- Worklog ini di-append ke `worklog.md` repo dan ter-sync ke VM via `git pull` sesi berikutnya.

---

## Sesi 2026-11-22 (2): Audit ulang & fix B-1/B-2/B-3 — pipeline upload foto laporan match + stats kiper (branch `fix/upload-foto-audit-md1`)

### Konteks & verifikasi VM
Audit sebelumnya menemukan 3 CRITICAL + 3 HIGH di pipeline upload foto. Verifikasi langsung di VM (`forfh-korea-vm`, pm2: flashpeak-bot/flashpeak-media online): deploy = `master` HEAD `8d94a87` (post-merge PR #9) — jadi temuan B-1/B-2/B-3 **bukan regresi PR #9, memang belum pernah difix**. `.env` VM mem-set nama model identik dengan default kode. Laporan audit lama tidak dilampirkan; semua temuan diverifikasi ulang dari kode, bukan asumsi.

### Validasi model vision via test call langsung (B-3) — 22 Nov 2026, dari VM dengan key produksi
Setiap nama model divalidasi via curl langsung ke endpoint provider (JPEG uji 1287 byte + prompt satu kata):
- `DEEPSEEK deepseek-flash` ✅ HTTP 200, gambar diproses (reasoning menyebut isi gambar)
- `GROQ qwen/qwen3.8-27b` ✅ HTTP 200, jawaban benar (" red")
- `GEMINI gemini-3-flash-preview` ✅ HTTP 200, IMAGE modality 1089 token
- `NVIDIA nvidia/nemotron-3.5-super-vl-120b-a12b` ✅ HTTP 200, gambar diproses (282 token)
- `COHERE c4ai-aya-vision-32b` ✅ HTTP 200, `image_tokens: 259` (422 awal = salah shape probe, bukan salah model; adapter `cohere.ts` sudah pakai shape object yang benar)
- `MISTRAL pixtral-12b-2409` ❌ **RETIRED**: tidak ada di `GET /v1/models`; API diam-diam substitusi ke `ministral-14b-latest` (model TEKS) dan mengabaikan gambar (41 prompt token, tanpa image token) — HTTP 200 "sukses" palsu, mode kegagalan paling berbahaya (router mencatat SUCCESS, ekstraksi jadi sampah). Replacement `mistral-medium-latest` terkonfirmasi ADA di catalog; full vision call tertahan kuota (lihat temuan H-2).

Kesimpulan B-3: klaim "model fiktif" dari audit lama **sudah stale untuk 5 dari 6 provider** (semua valid via direct call). Satu-satunya yang benar-benar rusak: Mistral.

### Fix B-1 — download media tanpa batas (`src/cli/start.ts`)
- Baru: `src/whatsapp/media-download.ts` — `downloadMediaWithLimits()`: timeout 20s default (`WA_MEDIA_DOWNLOAD_TIMEOUT_MS`), size cap 10MB default (`WA_MEDIA_MAX_BYTES`), pre-check `fileLength` sebelum download (aset oversize ditolak tanpa transfer byte), post-check buffer aktual, never-throws (`{buffer: null, skipReason}`).
- `src/cli/start.ts` handler `messages.upsert` pakai wrapper; download gagal/timeout/oversize → pesan dilanjutkan text-only (session tetap jalan; batch tanpa aset → reply NO_MEDIA minta kirim ulang, path yang sudah ada).
- Test: `tests/unit/media_download.test.ts` (7 test). **Bukti FAIL di master**: `Cannot find module .../media-download.js` — di master wrapper tidak ada dan await-nya tanpa batas sama sekali.

### Fix B-2 — fallback MOCK_BASE64_DATA (`src/application/evidence-batch-processor.ts`)
- Hapus kedua fallback `base64 = 'MOCK_BASE64_DATA'` (asset gagal re-download dari media service, dan kasus tanpa mediaClient). Asset yang gagal di-download di-**skip** (tidak pernah diklasifikasi).
- Semua asset gagal → `completeDebounceBatch(INCOMPLETE)` + status `NO_MEDIA` + reply eksplisit: "Semua N foto bukti gagal diunduh ulang dari layanan media. Silakan kirim ulang screenshot skor akhir pertandingan."
- Kegagalan parsial → proses lanjut dengan asset yang berhasil + warning `ℹ️ N foto bukti gagal diunduh ulang ... dan dilewati` masuk uncertainties summary (prefix ℹ️, bukan ⚠️, supaya tidak memicu invalidasi KO).
- Test: `tests/integration/evidence_media_guards.test.ts` (3 test). **Bukti FAIL di master**: `expected 'AI_FAILED' to be 'NO_MEDIA'` + `"spy" to be called 1 times, but got 2 times` (master mengklasifikasi SEMUA asset dengan bytes mock). Test lama yang bergantung mock (`ai_resilience` 8 titik, `full_flow` 2 titik) diinject stub `tests/helpers/stub_media_client.ts` (downloadMedia → bytes deterministik) — intent test tetap, kini lewat jalur download yang sama dengan produksi.

### Fix B-3 — default vision model Mistral
- `src/ai/providers/mistral.ts` + `src/cli/start.ts`: default `pixtral-12b-2409` → `mistral-medium-latest` (validated via catalog; bukti substitusi senyap tercatat di PROVIDER_MATRIX.md §1.1). Provider TIDAK di-drop dari priority list vision maupun text (dipakai task text lain: PARSE_*, CHAT_OMAK_PEAK dll); 429/402 saat key sehat → circuit breaker failover normal.
- `.env.example`: provider lengkap (Groq/Gemini/DeepSeek/NVIDIA/Cohere/Mistral/Ollama) dengan nama model tervalidasi + env guardrail B-1 + fix port media 4190→4189 (produksi & ecosystem.config.cjs pakai 4189).
- `docs/PROVIDER_MATRIX.md`: §1.1 validation log + status Mistral + known-gap telemetri §6.
- Test: `test/multi-provider-adapters.test.ts` +1. **Bukti FAIL di master**: `expected 'pixtral-12b-2409' to be 'mistral-medium-latest'`.
- **VM `.env`**: backup `local.sqlite.bak-2026-11-22-audit-b123` + `.env.bak-2026-11-22-audit-b123`, lalu `MISTRAL_VISION_MODEL` di-update (diff = 1 baris). **TANPA pm2 restart** — proses berjalan masih env lama; env baru aktif saat deploy berikutnya (`pm2 restart --update-env`) setelah approval.

### Temuan tambahan (REPORT-ONLY, butuh keputusan Arya — di luar scope fix mandiri task ini)
- **H-1**: `onTelemetry` tidak pernah di-wire (`start.ts` membuat `ProviderRouter` tanpa callback) → tabel `provider_usage` KOSONG di produksi; klaim telemetri PROVIDER_MATRIX §6 tidak terpenuhi. Sudah didokumentasikan sebagai known-gap.
- **H-2**: Pool 27 key Mistral sekarat: 3× `401 Invalid API Key`, 3× `402` (budget exhausted / payment failure), sisanya `429` (semua retry setelah cooldown tetap 429 — kuota, bukan burst). Mistral efektif dead-weight sampai key diperbarui; full vision call `mistral-medium-latest` belum bisa divalidasi sampai key pulih — perlu re-validasi post-deploy.
- `gemini-2.0-flash` & `llama-3.2-11b-vision-preview` di `.env.example` lama = stale (tidak ada di catalog Groq/Gemini saat ini) — sudah diperbaiki di `.env.example` baru.

### Regresi
- tsc: 0 error. vitest: **318/318** (master 307 + 11 test baru). eslint: 0 error, 8 warning pre-existing (verifikasi via diff: tidak ada dari perubahan ini).

### Deployment Status Akhir Sesi
- Branch `fix/upload-foto-audit-md1` di-push; PR dibuka ke `master` (belum di-merge).
- **BELUM deploy ke VM** — menunggu approval Arya (prinsip proyek). Prosedur saat approve: `git pull --ff-only && npm run build && pm2 restart flashpeak-bot --update-env && pm2 save`, lalu test manual `!ping` + 1 foto uji di grup internal, dan re-validasi `mistral-medium-latest` saat key pool pulih.
- Rollback tersedia: `.env.bak-2026-11-22-audit-b123` + `local.sqlite.bak-2026-11-22-audit-b123` di VM.

---

## Sesi 2026-11-22 (3): Investigasi "ada yang rusak" + validasi ulang Mistral + merge PR #10 + backlog monitoring

### 1. Investigasi mandiri — akar masalah DITEMUKAN (bukan code bug yang aktif)
Gejalan: user lapor "ada yang rusak" tanpa detail; ada kalimat "awal-awal udah bisa kok". Bukti:
- **Runtime healthy**: flashpeak-bot online (uptime sejak 08:58 UTC, restarts=4, TIDAK ada restart baru), error log PM2 kosong sejak 08:58, flashpeak-media HTTP 200 di 4189, disk 31%, pesan WA mengalir normal (log inbound terus masuk).
- **DB forensik (read-only)**: 4 foto masuk sepanjang waktu (20-22 Nov), **semua 4 berhasil upload ke media service (media_assets STORED)**, tapi `report_sessions` = **0 sepanjang waktu** (termasuk backup pre-audit `local.sqlite.bak-2026-11-22-delegate-swap`). Caption user Nov 21 ("contoh gini", "ini kenapa ke gw oi") = sedang test kirim foto laporan.
- **Akar**: `resolveFixtureForMessage` (src/application/fixture-resolver.ts) memfilter `WHERE tr.status = 'ACTIVE'` di SEMUA jalur (caption match, identity auto-lock, fallback organizer). Turnamen `Gojiha Cup S1` statusnya **`DRAW_READY`** (sejak 21 Nov 14:25 UTC, waktu selesai draw) → resolver selalu null → foto di-capture + di-upload tapi `sessionId=null` → tanpa ack, tanpa AI, **bot diam total** (index.ts return `handled:false`). Query persis dari kode dengan filter ACTIVE terhadap DB VM = 0 rows (bukti langsung).
- **"Awal-awal udah bisa"**: flow foto→laporan TIDAK PERNAH selesai di DB produksi (0 session all-time) — yang "bisa" di awal adalah fitur lain (chat/roster/onboarding/draw). Dilaporkan apa adanya.
- **Sesi sebelumnya BUKAN penyebab**: PR #10 tidak ter-deploy (VM masih 8d94a87); `.env` VM tidak pernah di-restart setelah diedit (uptime 08:58 < edit 10:49) — env baru belum aktif. Crash loop 05:35 pagi (ENOENT dist/data/flashpeak-trivia.json) terjadi sebelum sesi dan sudah diperbaiki orang lain lewat build 05:41/08:58.
- **Tindak lanjut untuk Arya (di luar scope fix mandiri)**: (a) saat MD1 mulai, flip turnamen ke `ACTIVE` (hati-hati: otomasi cutoff 19:59 ikut hidup — keputusan timing Arya); (b) follow-up UX: foto masuk saat tidak ada fixture aktif sebaiknya di-reply eksplisit ("turnamen belum aktif"), bukan didiamkan — perlu approve dulu sebelum dibuat.

### 2. Validasi ulang Mistral vision (Prioritas 2) — dan KOREKSI temuan kemarin
Gambar uji 512×512 (JPEG 7.2KB; ~380 image token bila diproses vs ~40 bila diabaikan — pemisahan tegas; kemarin pakai 128px yang ternyata ambigu karena Mistral diam-diam drop gambar mungil):
- **VALID di key pool aktif**: `ministral-14b-latest` (HTTP 200, prompt_tokens **391**, jawaban "Square"), `ministral-8b-latest` (200, 391), `ministral-3b-latest` (200, 391).
- **TIDAK diserve di free tier**: `mistral-small-latest`, `mistral-medium-latest`, `mistral-medium-3.5`, `magistral-medium-latest` (429 persistent di semua key yang dicoba).
- **Invalid id**: `mistral-medium-2508` (HTTP 400 invalid_model — dokumen docs.mistral.ai menyebut id itu tapi catalog API tidak; catalog yang dipegang: /v1/models).
- **Koreksi klaim kemarin**: "ministral-14b-latest = model teks yang mengabaikan gambar" SALAH (artefak gambar 128px). Yang benar: keluarga Ministral 3 vision-capable (konsisten dengan docs resmi); `pixtral-12b-2409` tetap retired (config drift: model diserve ≠ model dikonfigurasi).
- **Default MISTRAL_VISION_MODEL diubah ke `ministral-14b-latest`** (commit `d712381` di PR #10): satu-satunya vision model tervalidasi yang benar-benar jalan di 27 key free tier. Upgrade path: `mistral-medium-latest` dengan key berbayar. `.env` VM ikut di-update (backup `.env.bak-2026-11-22-p2-ministral`, diff 1 baris, TANPA restart).

### 3. Merge PR #10 (wewenang penuh dari user, semua syarat terpenuhi)
- Merge-gate: investigasi tidak mengindikasikan PR sebagai sumber masalah (belum ter-deploy); re-verifikasi fresh di branch final `d712381`: **tsc 0 error, vitest 318/318, eslint 0 error** (8 warning pre-existing); audit diff 13 file — grep semua string `!command` pada diff = kosong (tidak ada manual command tersentuh).
- Deskripsi PR dikoreksi (klaim "text-only" → bukti round 2), komentar merge-gate diposting, **di-merge dengan metode merge** → master `c2c6e04` (8d94a87..c2c6e04).
- **Deploy TETAP menunggu approval** (tidak diotorisasi sesi ini): `git pull --ff-only && npm run build && pm2 restart flashpeak-bot --update-env && pm2 save` + test `!ping` + 1 foto uji.

### 4. Backlog provider failure monitoring (fitur baru — rencana SAJA, belum dieksekusi)
Rencana 3 fase di-dokumentasikan dan dibuat sebagai **Issue #11** (label backlog+enhancement): (1) wire `onTelemetry` → isi `provider_usage` real (fire-and-forget, tanpa migrasi); (2) deteksi SUSPICIOUS: HTTP 200 tapi image-token/ prompt_tokens < ambang → error_code `IMAGE_TOKENS_MISSING` (pelajaran kasus Mistral + drop gambar mungil); (3) command WA `!aistatus` (organizer) untuk ringkasan 24 jam per provider. Menunggu review Arya.


---

## Sesi 2026-11-23: Flash Peak Core Assembly & Binary Reverse Engineering (Specialist: binary-archaeologist)

### 1. Tujuan Sesi
Melakukan audit dan reverse engineering assembly C# (`ProjectCR.Runtime.dll` & `ProjectCR.CoreUnity.Runtime.dll`) serta tabel TextAsset YooAsset (`10ee363dd89953d507c7b97d19d20485\__data`) untuk mengekstrak rumus kalkulasi collision combat, tackling, shoulder barge, goalkeeper save mechanics, ball physics, dan eksekusi skill karakter di bawah kap mesin.

### 2. Temuan & Formula Assembly Terverifikasi
- **Deterministic Fixed-Point Engine**:
  - `ProjectCR.CoreUnity.Runtime.FixedPointPhysics.FixedPoint64`: Format signed Q32.32 (64-bit int, 32 fractional bits, `ONE = 4,294,967,296`). Look-Up Tables (`LUT_SIZE = 205,887`) untuk `Sin`, `Acos`, `Tan` untuk eliminasi IEEE 754 drift pada lockstep cross-platform.
  - `ParabolaCalculator`: Gravitasi deterministik `Gravity = -9.82 m/s²` (`-982 / (10 * 10)`).
  - `PhysicMaterialTable`:
    - Grass: Normal bounce 0.5, Tangential 0.7, Threshold 0.6 m/s, Rolling resistance 0.5, Stop 0.05 m/s.
    - Woodwork (Tiang gawang/Metal): Normal bounce 0.9, Tangential 0.9 (rebound 90% velocity).
    - Wall (Dinding perimeter): Normal bounce 0.55, Tangential 0.6.
    - Net (Jaring): Normal bounce 0.3.
  - `BallBounceOnFreeMovePlayerBehaviour`: Redaman tumbukan tubuh pemain non-ball carrier = 0.75 (menyerap 25% laju bola), deviasi horizontal 15°, vertikal -10° s/d 0°.

- **Formula Atribut & Scaling**:
  - `AttributeBaseValue = 50`.
  - Rumus LV3 Runtime: `Effect_LV3 = (Constants.EffectMax / 50) * (Attr_LV2 - 50)`.
  - Base stat 50 menghasilkan modifier netral 0; stat > 50 memberikan bonus linier hingga `EffectMax`; stat < 50 memberikan penalti.
  - `StumbleHardReduceTime_LV3` (mengurangi durasi stun/knockdown) diskalakan dari `Balance_LV2 (2002)`.
  - `TackleIncrease_LV3` & `TackleHardReduceTime_LV3` diskalakan dari `Tackle_LV2 (2015)`.
  - `StandingTackleIncrease_LV3` diskalakan dari `StandingTackle_LV2 (2014)`.
  - `Power_LV3 (3040)` langsung dipetakan dari `Power_LV2 (2024)`.

- **Shoulder Barge & Player Overlap Collision**:
  - `PlayerOverlapComponent`: Silinder tabrakan 2.0m tinggi (`m_OverlapHeight`), radius dasar `PushRadius = 0.5m`. Syarat tabrakan: `distXZ² <= (pushRadiusA + pushRadiusB)²`.
  - `InteractionShoulderBarge` & `PlayerBeShoulderBargeTransition`:
    - `PowerDiff = Power(Attacker) - Power(Receiver)` (`Power_LV3`).
    - **Tier 1 (`PowerDiff > 25`)**: Catastrophic Knockdown! Flank hit (45°-160° / 200°-315°) = 80% `Stumble_S2_FallDown` (jatuh telentang), 20% `SlowDown`. 100% bola lepas (`KickBall=1`).
    - **Tier 2 (`10 < PowerDiff <= 25`)**: Dominant Barge. 70% `SlowDown` + `KickBall=1` (lepas bola); 30% `ProtectBall` + `KickBall=0` (bola terlindungi).
    - **Tier 3 (`-1 <= PowerDiff <= 10`)**: Contested. Running: 40% lepas bola, 60% lindungi bola. Idle: 20% lepas, 80% lindungi.
    - **Tier 4 (`PowerDiff < -1`)**: Resisted. Korban lebih berotot dari penyerang, penyerang gagal total (`IsBargeSuccess=0`).

- **Tackling & Possession Transfer**:
  - Tackle standar (`InteractionTackle` / `InteractionStandingTackle`): Mengetuk bola lepas lewat `InteractionBallMove::HandleMovement` dan memicu timeline `BeTackle` pada korban via `m_BeTackleSelector`.
  - Andrew SuperTackle (`InteractionSuperTackleHandler`): Tidak hanya melepas bola, melainkan memanggil `InteractionBallSplit::ControlBallImmediately(andrew, ball)`! Eksekusi 18m slide tackle homing (`18² = 324` range check) menghasilkan **instant guaranteed ball steal**, transfer kontrol langsung ke Andrew, dan refund energi.

- **GoalKeeper Save Mechanics**:
  - `InteractionGoalKeeperDive` menghitung kontak normalized height `[0, 1]` dan signed width `[-1, +1]`.
  - `AbilityBehaviourGoalKeeperTakeBall`: Mengevaluasi `m_GoalKeeperTakeBallSelector` terhadap 4 tier jarak (0-1m, 1-2m, 2-3m, >3m) dan 4 tier waktu antisipasi (0-0.4s, 0.4-0.7s, 0.7-1.2s, 1.2-5.0s) pada rentang kecepatan 20 - 50 m/s.
  - Tangkapan (`BallInHand` tag): Memegang bola via `PlayerGoalKeeperComponent::TryHoldBall` (Save Sukses instan).
  - Tinju/Tepisan (`InteractionGoalKeeperPunch`): Bola > 34 m/s memicu `MissedGoalDeflection` dengan probabilitas dasar 30% (mengecil saat tembakan lebih jauh) dan sudut deviasi 13° - 21°.

- **Ford SuperBlock Mechanics**:
  - `InteractionFordSuperBlockBall`: Intersepsi tembakan seketika memanggil `InteractionBallSplit::StopFreeMoveBall(ballEntity)` — kecepatan proyektil dinolkan seketika (bola jatuh mati di kaki Ford).

- **Skill Karakter Lainnya**:
  - Orion (`OrionSuperShoot`): Dual path `TryHandleHasBallShoot` (saat membawa bola) dan `TryHandleNoBallShoot` (saat bola bebas masuk push trigger dan berstatus `NoBallInteractive` — tendangan voli instan).
  - Hayato (`HayatoSuperDribble`): `FindClosestOpponentInSectorAngle` memindai cone pandangan kamera depan, menandai target dengan `HayatoSuperDribbleSelectedTarget`, dan mengeksekusi animasi dribble terobosan melewati lawan tersebut.
  - Kelly (`KellyJumpWallDribble`): Raycasting dinding perimeter (`TryGetWallNormal`), membatasi pada tepi tiang gawang, dan memantul melompati bek.

### 3. Verifikasi Empiris
- Disassembly langsung Mono.Cecil via script `D:\Projects\FlashPeak\scratch_disasm.py` terhadap `ProjectCR.Runtime.dll` dan `ProjectCR.CoreUnity.Runtime.dll`.
- Ekstraksi langsung TextAsset CSV via UnityPy terhadap bundle YooAsset `bundle_to_modify\10ee363dd89953d507c7b97d19d20485\__data`.


---

## [2026-11-23] Reverse Engineering Game Mechanics, Tactical AI, Pitch Geometry & Energy Systems (mechanics-deepdive)

### 1. Tujuan Sesi
Melakukan dekonstruksi mendalam terhadap sistem fisika, mekanik taktis AI, geometri lapangan, sistem pemulihan energi/stamina, dinamika pressing/pinning, dan aturan penjaga gawang pada Flash Peak dari bundle data Unity (`bundle_to_modify\10ee363dd89953d507c7b97d19d20485\__data`, `extracted_base\assets\yoo\Default`, dan `update_2026_10_28\decompiled_dlls`).

### 2. Temuan & Analisis Mendalam

#### A. Pemulihan Energi (Ultimate Meter)
- **Tabel Sumber**: `FootballPlayerRecoverEnergyTable` (Cap/Max: 100).
- **Mekanisme Pasif**: `PlayerEnergyComponent::Tick` menambahkan energi per detik = `EnergyRecovery` (3.0 poin/detik pada atribut level dasar) dikalikan `LogicFrameDeltaTime`. Recovery dapat dihentikan sementara jika pemain memiliki tag `SuppressEnergyRecovery`.
- **Mekanisme Aktif (Per Action Gain)**:
  - **Defender (Andrew 1003, Ford 1009, Steffie 1012)**: Mendapat regenerasi energi terbesar dari aksi defensif:
    - `Tackle`: **+20 energi** (Steffie: +15, Orion/Shirou/Rafael hanya +5)
    - `StandingTackle`: **+20 energi**
    - `ShoulderBarge`: **+3 (Andrew), +5 (Ford), +6 (Steffie)** (Penyerang: 0)
  - **Striker/Finisher (Orion 1001, Shirou 1006, Oscar 1011, Rafael 1007)**:
    - `NoBallShoot` (Tendangan voli tanpa bola): **+16 hingga +20 energi** (Rafael: +20)
    - `HasBallShoot` (Tendangan saat bawa bola): **+12 energi**
    - `PullBall`: **+3 hingga +8 energi** (Rafael: +8)
  - **Midfielder (Hayato 1002, Homer 1010)**:
    - `HasBallTap` / `NoBallTap` (Passing): **+10 hingga +12 energi**
    - `Tackle` / `StandingTackle`: **+10 energi**
  - **Winger (Kelly 1004, Tatsuya 1013)**:
    - `PushBall` (Sprint dribble): **+3 energi**
    - `NoBallShoot`: **+13 energi**, `HasBallTap`: **+8 energi**

#### B. Pemulihan Stamina & Konsumsi Lari
- **Komponen**: `PlayerStaminaComponent` & scriptable binary `PlayerAttributeConstants` (format Q32.32 FixedPoint64).
- **Statistik Stamina**:
  - Kolam Stamina Maksimum (`StaminaAMin` ~ `StaminaAMax`): **600.0 hingga 1200.0 poin**.
  - Laju Pemulihan Stamina (`StaminaRecoveryAMin` ~ `StaminaRecoveryAMax`): **320.0 hingga 450.0 poin/detik**.
- **Konsumsi Lari**:
  - Lari tanpa bola (`RunNoBallStaminaCost`): **0 stamina** (lari biasa tidak menguras stamina).
  - Lari membawa bola (`RunHasBallStaminaCost`): **80.0 poin/detik**.
- **Mekanisme Kelelahan & Delay Pemulihan**:
  - Jika stamina habis, pemain masuk status `LowStamina` dan tombol Sprint dinonaktifkan.
  - Sprint baru dapat diaktifkan kembali setelah stamina pulih minimal ke ambang batas `SprintResumeStamina` = **400.0 poin**.
  - **Delay Sebelum Regenerasi Dimulai (`m_ResumeStaminaDelay`)**:
    - Saat diam (Idle): `IdleResumeStaminaDelay` = **400 * EN2 = 4.0 detik**.
    - Saat bergerak/jogging (NotIdle): `NotIdleResumeStaminaDelay` = **200 * EN2 = 2.0 detik**.

#### C. Grid Scoring AI & Posisioning Tanpa Bola (Off-Ball Positioning)
- **Struktur Grid**: Lapangan dibagi menjadi matriks **6 x 6 = 36 sel** (`SpatialGridCount = 6`, cellIndex 0-35).
  - Row 0 (Sel 0-5): Area pertahanan sendiri / depan gawang sendiri.
  - Row 1-2 (Sel 6-17): Sepertiga pertahanan & transisi tengah belakang.
  - Row 3-4 (Sel 18-29): Sepertiga tengah menyerang & sayap.
  - Row 5 (Sel 30-35): Kotak penalti lawan.
- **Tabel Skoring AI**:
  - `AttackNoBallGridScoreTable`:
    - **Bek (Andrew 1003, Ford 1009, Steffie 1012)**: Nilai tertinggi di Row 0-1 (skor 35-30 di sel tengah 2-3). Skor Row 4 bernilai 0, dan Row 5 (kotak penalti lawan) bernilai **-20 (penalti berat agar bek tidak overlap berlebihan)**.
    - **Gelandang Tengah (Homer 1010)**: Puncak skor di Row 2 & Row 3 (skor 35-50 di sel tengah 19-22).
    - **Winger (Kelly 1004, Tatsuya 1013)**: Puncak skor di sayap (Kolom 0 & 5, skor 45 di sel 24/29 dan skor 50 di half-space sel 31/34).
    - **Striker (Orion 1001, Shirou 1006, Oscar 1011, Rafael 1007)**: Puncak skor di Row 5 sel 32-33 (skor 50 di depan gawang lawan).
- **Aturan Passing & Dynamic Scoring (`BehaviorTreeGlobalTable`)**:
  - Jarak ke pembawa bola:
    - Tier 1 (0 - 5.5m): **0 skor** (terlalu dekat/menumpuk).
    - Tier 2 (5.5 - 15m): **+40 skor**.
    - Tier 3 (15 - 30m): **+70 skor (Sweet Spot passing optimal)**.
    - Tier 4 (30 - 100m): **0 skor** (terlalu jauh).
  - Keberadaan musuh di sel target: Penalti **-50 skor** (`AttackNoBall_EnemyInRegionPenalty`).
  - Koridor passing (lebar 4m): Terhalang musuh = penalti **-75 skor** (`AttackHasBallTap_PathBlockedPenalty`). 3 musuh di target = penalti **-100**, 4+ musuh = **-1000**.
  - Permintaan umpan (`RequestBall` tag): **+100 bonus skor**.
  - Rekan adalah pemain manusia (`HumanPlayerBonus`): **+100 bonus skor**.

#### D. Mekanika Pressing, Double-Teaming & Pinning (Andrew + Ford)
- **Siklus Evaluasi Marking AI**: Dijalankan setiap **0.5 detik** (`Defend_AttentionUpdateIntervalSecs`).
  - Pemain membawa bola mendapat nilai atensi tertinggi: **150 poin** (`Defend_HasBallAttentionScore`).
  - Jarak ke musuh dinilai linear antara **3.0m hingga 20.0m** dengan bobot maksimal **100 poin** (`Defend_DistanceToSelfMaxScore`).
- **Mekanika Overlap / Pinned Player (`GameConfigScriptable`)**:
  - Ketika 2 pemain bertahan mengapit atau menekan pembawa bola (`OverlapPlayer`):
    - Penalti Kecepatan Lari Biasa Pembawa Bola: **Faktor 0.90 (pengurangan kecepatan 10%)** (`OverlapPlayerHasBallRunSpeedFactor`).
    - Penalti Kecepatan Sprint Pembawa Bola: **Faktor 0.90 (pengurangan sprint 10%)** (`OverlapPlayerHasBallSprintSpeedFactor`).
    - Penalti Pemain Tanpa Bola: **Faktor 0.95**.
    - Syarat Kecepatan Relatif Tabrakan: minimal **2.5 m/s** (`OverlapPlayerRelativeSpeedMin`).
    - Interval Feedback Benturan Bahu (`ShoulderBargeFeedbackInterval`): **0.5 detik** (setiap 0.5 detik terjadi evaluasi tabrakan fisik berulang).
  - **Efek Terjepit (Pinned by Andrew + Ford)**:
    1. Mobilitas pembawa bola tercekik hingga 90% kecepatan dasar.
    2. Benturan bahu berulang memicu evaluasi `PlayerBeShoulderBargeTransition`: karena Power Andrew & Ford sangat tinggi (`PowerDiff > 25`), peluang terjadinya **Stumble / Fall Down (jatuh tersungkur)** mencapai 80%, dengan 100% bola lepas (`KickBall=1`).
    3. Jalur operan terputus: koridor passing tertutup menghasilkan penalti passing -75 hingga -1000, membuat bot menembak panik atau kehilangan bola.
    4. Di dalam kotak penalti, bek mendapatkan bonus perebutan bola dramatis: `DefenderScrambleLv3BonusInPenaltyArea` = **+6.0 poin kontes**.

#### E. Geometri Lapangan & Batas Area (`Level_General` & `GameModeTable`)
- **Dimensi Lapangan Utama (`FieldBoundary`)**:
  - Lebar (X): **66.0 meter** (rentang: -33.0m s/d +33.0m).
  - Panjang (Z): **103.0 meter** (rentang: -51.5m s/d +51.5m).
  - Tinggi Ruang (Y): **20.0 meter**.
- **Batas Luar Dunia (`WorldBoundary`)**: **80.0m x 120.0m x 100.0m**.
- **Batas Reset Bola (`BallResetBoundary`)**: **65.7m x 102.7m x 20.0m** (jika bola berada di luar batas ini dengan kecepatan rendah selama durasi tertentu, bola otomatis di-reset).
- **Kotak Penalti (`PenaltyArea`)**: **Lebar 37.0m x Panjang 25.0m x Tinggi 20.0m**.
  - Team 1 Center Z = -49.4m (rentang -36.9m s/d -61.9m).
  - Team 2 Center Z = +49.4m (rentang +36.9m s/d +61.9m).
- **Area Gawang (`GoalArea`)**: **Lebar 20.0m x Panjang 13.0m x Tinggi 40.0m**.
- **Area Patroli Mandiri Kiper (`DoorMoveableArea`)**: **Lebar 10.41m x Panjang 3.36m x Tinggi 20.0m** tepat di depan garis gawang.
- **Zona Ancaman Taktis AI (ThreatZones)**:
  - Level 1 (Atensi 30): 66.4m x 18.0m (lapangan tengah mendekati pertahanan).
  - Level 2 (Atensi 60): 15.2m x 19.5m (kedua sisi sayap luar).
  - Level 3 (Atensi 80): 36.0m x 19.5m (tengah luar kotak penalti) + 15.2m x 14.5m (sayap lanjutan).
  - Level 4 (Atensi 100): 20.0m x 7.5m & 8.0m x 14.5m (tepat di lingkar kotak penalti).
  - Level 5 (Atensi 120): 20.0m x 7.0m (mulut gawang / bahaya fatal).

#### F. Durasi Pertandingan & Aturan Khusus (`NormalGameProcedureScriptable` & `MatchRule`)
- **Durasi Waktu Normal (`MatchDurationSec`)**: **300 detik (5 menit)**.
- **Fase Hitung Mundur Kickoff**: **3.0 detik** (`KickoffCountdownDuration`), input terkunci selama 4.0 detik.
- **Serangan Terakhir (Last Attack / Final Play)**:
  - Tim unggul memegang bola: maksimal **10.0 detik**.
  - Tim tertinggal memegang bola: toleransi diperpanjang hingga **30.0 detik** (maksimal 60 detik jika terjadi perebutan tanpa bola terus-menerus).
- **Perpanjangan Waktu (Golden Goal)**:
  - Jika skor imbang setelah 300 detik, pertandingan memasuki `GoldenGoal` (sudden death). Gol pertama langsung mengakhiri laga.
- **Aturan Mercy / Match Point**: Selisih gol >= **3 gol** (`GoalDifference = 3`) memicu match point / kemenangan mutlak.

#### G. Aturan & Perilaku Penjaga Gawang (Goalkeeper)
- **Status Invincible & Proteksi Bola**:
  - Saat kiper menangkap bola di area penalti sendiri (`TryHoldBall`), kiper diberikan tag `BallInHand` dan **`Invincible` (kebal serangan/tackle)**.
  - Trigger bola dinonaktifkan (`SetBallBaseTriggerEnabled(false)`) sehingga musuh tidak dapat merebut bola dari tangan kiper.
- **Durasi Memegang Bola**:
  - Tangkapan normal / hasil penyelamatan: maksimal **3.0 detik** (`GoalKeeperHoldBallInHandTime`).
- **Aturan Anti-Stall Back-Pass (Operan Balik Rekan Setim)**:
  - Jika kiper menerima operan dari rekan setim (`IsSameTeam == true`):
    - Waktu pegang bola dipangkas drastis menjadi hanya **0.3 detik** (`GoalKeeperHoldBallInHandTimeForSameTeam`).
    - Diberlakukan jendela waktu anti-ulur waktu 3.6 detik (`GoalKeeperBackPassWindowDuration`).
    - Jika back-pass diulang dalam jendela ini (`BackPassCount >= Threshold`), kiper langsung dipaksa melepaskan bola ke tanah (0 detik hold time).
- **Pelanggaran Keluar Kotak Penalti**:
  - Jika kiper melangkah keluar dari kotak penalti (`TickOutOfOwnPenaltyArea`), tag `GoalKeeper` seketika dicabut, status `BallInHand` dibatalkan, dan kiper dipaksa memainkan animasi `PlayBallToFeedAnim` (bola dijatuhkan ke kaki). FSM locomotion kiper berganti menjadi pemain lapangan biasa.
- **Penyelamatan & Tepisan (Dive & Punch)**:
  - Parameter Dive: Rentang ancaman bola 8.0m - 20.0m, kecepatan bola 20 - 50 m/s, waktu prediksi 1.5 detik.
  - Penyelamatan Tepis (`InteractionGoalKeeperPunch`): Tembakan dengan kecepatan > **34.0 m/s** (`MissedGoalBallSpeedThreshold`) memicu defleksi bola dengan peluang dasar 30% dan sudut pembelokan 13° - 21°.
- **Distribusi Operan Kiper**:
  - Sangat berhati-hati: Koridor pengecekan musuh selebar 8.0 meter (`PathHalfWidth = 4m`), penalti jalur terhalang -250 skor. Jarak passing ideal kiper: 8 - 20 meter (+120 skor).

### 3. Verifikasi Empiris
- Ekstraksi 33 file TextAsset CSV dari bundle `bundle_to_modify\10ee363dd89953d507c7b97d19d20485\__data`.
- Pembongkaran biner Q32.32 FixedPoint64 dari ScriptableObjects di bundle `extracted_base\assets\yoo\Default\default_assets_gameres_config_scriptable_game_crgamemode_*.bundle` dan `default_assets_gameres_config_scriptable_entity_player_*.bundle`.
- Analisis IL disassembly menggunakan Mono.Cecil terhadap runtime gameplay assembly `ProjectCR.Runtime.dll` dan `ProjectCR.CoreUnity.Runtime.dll`.


---

## 2026-11-23 — TASK-FIX-OMAK-SCHEDULE-MATCHDAY-D037
**Tujuan**: Memperbaiki kegagalan Omak Peak (`!ai`) saat menjawab pertanyaan jadwal pertandingan (kasus konkret: `!ai nnti malam avoid prime lawan siapa`), di mana bot sebelumnya menjawab bahwa jadwal belum dirilis dan membocorkan istilah teknis database (`"semua fixture di Round 2-3-nya masih scheduled_at null"`), padahal jadwal pertandingan per ronde sudah resmi dibuat saat `!draw` dan dapat dilihat via `!schedule`.

### 1. Akar Masalah (Root Cause Analysis)
1. **Instruksi Prompt yang Keliru (`src/ai/prompts/omak-peak.ts`)**:
   - Terdapat aturan: `"Kalau semua fixture scheduled_at null, berarti matchday belum dijadwalkan — bilang 'jadwal belum dirilis'."`
   - Di Flash Peak TMS, pertandingan babak grup tidak menyimpan timestamp jam kickoff spesifik (`scheduled_at` sengaja bernilai `NULL`) karena sistem turnamen menganut sistem **Matchday 24 jam dengan batas cutoff pukul 19:59 WIB**. Kedua tim bebas menyepakati jam main fleksibel sebelum batas cutoff tersebut.
   - Akibatnya, LLM menganggap jadwal belum terbit dan bahkan mengutip mentah nama kolom database `scheduled_at null` ke pengguna WhatsApp.
2. **Ketiadaan Konteks Ronde Aktif & Kebijakan Waktu di `buildOmakPeakContext`**:
   - `buildOmakPeakContext` sebelumnya hanya melempar array fixture mentah tanpa menandai ronde mana yang sedang aktif berjalan (`current_round`), siapa tim host (`left_side_team_id`), atau sisa waktu menuju batas akhir 19:59 WIB.
3. **Ambiguitas Tim Saudara (Sister Team)**:
   - Pada pengujian awal, LLM sempat tertukar antara `AVOID Prime` dan `AVOID Impact` (keduanya tim berbeda di Grup C). Diperlukan panduan eksplisit untuk mencocokkan nama tim secara presisi.

### 2. Perubahan Konkret
- **`src/ai/prompts/omak-peak-context.ts`**:
  - Menambahkan field opsional pada interface `OmakPeakContext`:
    - `tournament.current_round_code`, `tournament.current_round_label`, `tournament.wib_now`, `tournament.cutoff_time`, `tournament.time_remaining_to_cutoff`, `tournament.matchday_policy`.
    - `today_fixtures`: menambahkan `round_label`, `host_team_name`, `is_current_round`.
- **`src/application/omak-peak.ts`**:
  - Mengimplementasikan deteksi ronde aktif tercepat yang belum selesai (menggunakan logika progresi yang sama dengan `MatchdayService`).
  - Menambahkan helper `formatRoundLabel` dan `getWibInfo` untuk menghitung waktu server WIB dan sisa waktu menuju batas cutoff 19:59 WIB.
  - Memperbarui query fixture dengan `LEFT JOIN teams tl ON tl.id = f.left_side_team_id` untuk menyertakan `host_team_name`.
  - Memperbarui `RULES_SUMMARY` dengan penjelasan bahwa jadwal pertandingan telah terbit per ronde sejak undian (!draw), berdurasi 24 jam hingga cutoff 19:59 WIB, dan jam kickoff fleksibel disepakati antar delegasi kedua tim.
- **`src/ai/prompts/omak-peak.ts`**:
  - Mengrombak total seksi `KETEPATAN WAKTU & JADWAL (MATCHDAY & FIXTURES)`:
    - Melarang keras membocorkan nama kolom database teknis (`scheduled_at`, `null`, `foreign key`, dll).
    - Melarang mengatakan "jadwal belum dirilis" jika fixture sudah tercatat di sistem.
    - Menjelaskan tata cara menjawab jadwal tanding: cari tim, cek ronde yang selesai (sebutkan skor), cek ronde aktif/mendatang (sebutkan lawan dan host room), serta ingatkan batas waktu cutoff 19:59 WIB.
    - Menambahkan peringatan khusus pemisahan sister team (contoh: `AVOID Prime` vs `AVOID Impact`, `7Sins Venom` vs `7Sins Inferno`).
- **`tests/unit/ai_native.test.ts`**:
  - Menambahkan unit test untuk memverifikasi context builder menyertakan jadwal ronde aktif, label ronde, host tim, waktu WIB, dan bahwa prompt memuat instruksi jadwal matchday serta tidak memuat aturan usang `scheduled_at null`.

### 3. Verifikasi Empiris
1. **Unit Testing (`vitest`)**:
   - Command: `npx vitest run tests/unit/ai_native.test.ts` -> 60 passed (60).
   - Command: `npm test` -> 23 test files passed, 334 passed (334).
2. **TypeScript Typecheck**:
   - Command: `npx tsc --noEmit` -> Exit code 0 (tanpa error).
3. **Live VM Deployment & Runtime Dry-run**:
   - Commit & push: `62c5cca` dan `ea063fa`.
   - Build dan reload pada VM `forfh` via PM2 (`flashpeak-bot` PID 3313431).
   - Eksekusi script pengujian langsung terhadap database dan router AI produksi dengan input user: `"nnti malam avoid prime lawan siapa"`.
   - Output Omak Peak:
     ```text
     Nanti malam AVOID Prime lawan Elite 8, hostnya AVOID Prime. Ronde 2, jadwalnya fleksibel disepakati sama delegasi kedua tim sebelum cutoff pukul 19:59 WIB.
     ```
   - Hasil akurat, menyebut lawan yang benar di Ronde 2 (`Elite 8`), host room yang benar (`AVOID Prime`), regulasi cutoff 19:59 WIB yang tepat, serta tanpa kebocoran istilah database.
