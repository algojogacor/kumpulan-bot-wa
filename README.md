# 🤖 Kumpulan Bot WhatsApp (Baileys Monorepo)

Repositori ini merupakan koleksi komprehensif berbagai proyek **Bot WhatsApp** yang dibangun menggunakan **Node.js / TypeScript** dan library **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)**.

Koleksi ini mencakup berbagai use-case canggih mulai dari bot multifungsi skala besar, asisten turnamen esports, AI virtual girlfriend interaktif, pembuat stiker performa tinggi, riset keamanan LLM, hingga agen otonom cloud 24/7.

---

## 📂 Struktur Direktori Proyek

```
kumpulan-bot-wa/
├── 📁 bot-multifungsi/       # Algojo Bot WA v2.0 — Flagship Multifungsi (AI, Ekonomi, Game, Media)
├── 📁 bot-pacar/             # AI Virtual Girlfriend — Proaktif, Voice Note PTT, Selfie, RAG Memory
├── 📁 bot-stickerinaja/      # Sticker Maker & Media Suite — Efisiensi tinggi, Telegram pack, Downloader
├── 📁 bot-turfpeak/          # Flash Peak TMS — Esports Tournament Management System & OCR
├── 📁 bot-wirtz-rag/         # Personality Chatbot — RAG Vektor Cohere, Dialek Jawa Slang, DeepSeek
├── 📁 bot-godmode-ai/        # AI Security Research — Boundary Inversion & 33 Parseltongue Techniques
├── 📁 bot-cloud-agent/       # Always-On Cloud Agent — Koyeb 24/7, Perplexity Web Search, Nanobot
└── 📄 README.md              # Dokumentasi & Panduan Lengkap
```

---

## 🌟 Rincian Bot & Fitur di Setiap Folder

### 1. 📁 `bot-multifungsi` (Algojo Bot WA v2.0)
> **Flagship Multifungsi Bot** dengan lebih dari 50 modul perintah mandiri di folder `commands/`. Menggabungkan AI generatif, simulasi ekonomi dunia maya, sportsbook taruhan bola, mini-game, dan utilitas grup.

* **🤖 AI Multi-Model & Persona (`commands/ai.js`, `commands/aitools.js`)**:
  * Chat AI berbasis OpenRouter dengan pemilihan tier performa (`!ai`, `!ai0`, `!ai1`, `!ai2`, `!ai3`).
  * **10 Karakter Persona AI** (`!persona`): *default, english, coder, motivator, chef, dokter, lawyer, psikolog, penulis, bisnis*.
  * **AI Vision** (`!aianalysis`): Membaca dan menganalisis foto/dokumen/grafik.
  * **AI Suite** (`!summarize`, `!translate`, `!ocr`, `!codereview`, `!improve`, `!grammar`, `!sentiment`, `!explain`, `!keywords`, `!fakta`).
* **🎨 AI Image & Steganografi (`commands/image.js`, `commands/stegano.py`, `commands/bgtools.js`)**:
  * Text-to-Image AI dengan opsi style visual dan 3 variasi (`!img`, `!imgstyle`, `!imgvariasi`).
  * Penghapus latar belakang foto otomatis (`!bg`).
  * **Steganografi LSB** (`stegano.py`): Menyisipkan teks rahasia ke dalam piksel gambar dan mengekstraknya kembali tanpa merusak gambar.
* **💼 Simulasi Ekonomi, Investasi & Kriminalitas**:
  * **Perbankan & Dompet**: `!daily`, `!balance`, `!depo`, `!tarik`, `!transfer`, `!pinjam`, `!leaderboard`.
  * **Karier & Profesi**: `!kerja`, `!daftarpekerjaan`, `!gaji`, `!lembur`, `!promosi`, `!resign`.
  * **Pasar Modal & Aset**: Trading kripto live via CoinGecko (`!crypto`, `!buycrypto`), pasar saham IDX (`!saham`, `!belisaham`, `!dividen`), grafik aset (`!chart`), dan valuta asing (`!valas`).
  * **Industri & Real Estate**: Beli/sewa properti komersial (`!properti`), pabrik pengolahan (`!pabrik`), dan tambang mineral mentah (`!mining`, `!peleburan`).
  * **Peternakan & Pertanian**: Siklus bertani (`!kebun`, `!bibit`, `!panen`) dan ternak hewan (`!kandang`, `!pakan`, `!obati`, `!jualhewan`).
  * **Mekanik Kehidupan & Kriminal**: Status lapar/stamina (`!makan`, `!tidur`, `!bangun`), rumah sakit (`!rs`, `!revive`), dan perampokan pemain lain (`!rob`).
  * **Simulasi Perang Negara (`!negara`)**: Membangun benteng, merekrut tentara, dan ekspansi wilayah.
* **⚽ Sportsbook Taruhan Bola & Game Casino**:
  * **Sportsbook Pro (`commands/bola.js`)**: Pasaran bursa taruhan dunia dengan tipe 1X2, Asian Handicap (voor), Over/Under, dan Mix Parlay multi-laga.
  * **Casino Games**: Roulette Eropa 0-36 (`!rolet`) dan tebak ranjau multiplier (`!mines`).
  * **PVP & Game Interaktif**: Duel taruhan (`!duel`), RPG PvP (`!battle`), catur visual di chat (`!catur`), Jin Akinator (`!akinator`), Wordle Indonesia (`!wordle`), dan tebak kata/gambar.
  * **HTML5 Game Bridge**: Sinkronisasi saldo bot dengan game web browser RPG & Snake (`!rpg`, `!claimslither`).
* **👑 Admin Abuse Chaos Events**:
  * Pemicu event global langsung di grup: `!hujan_uang`, `!jackpot_bersama`, `!borong_pasar`, `!meteor_langka`, `!musim_panen`, `!balapan_klik`.
* **🛡️ Moderasi Grup & Utilitas**:
  * Tagall, Hidetag, Anti-link, Anti-spam, Welcome/Goodbye kustom, Mute grup, dan Rules.
  * Reminder otomatis berbasis cron (`!remind 30m Minum obat`).
  * Pengunduh TikTok tanpa watermark (`!tiktok`), generator QR code, password generator, IP info, kurs, dan cuaca.

---

### 2. 📁 `bot-pacar` (AI Virtual Girlfriend)
> **AI Virtual Girlfriend Interaktif** dengan persona human-like yang natural, hangat, sedikit manja, dan mampu bertindak proaktif layaknya interaksi WhatsApp sungguhan.

* **💬 Percakapan Manusiawi**:
  * Gaya bahasa santai dan natural (bukan seperti asisten robot formal).
  * Sistem balasan **Multi-Bubble Chat** (2–3 balon chat pendek berurutan dipisah `|` dengan jeda ketik alami).
* **⏰ Perilaku Proaktif (Chat Duluan)**:
  * Mengucapkan selamat pagi saat bangun dan selamat malam sebelum tidur (mencatat waktu istirahat agar tidak mengganggu).
  * Mengingatkan makan siang dan menanyakan kabar aktivitas di sore hari.
  * **Fitur "Nyariin"**: Berinisiatif chat duluan jika pengguna tidak ada kabar atau idle berjam-jam (>90 menit).
  * Mengirimkan pesan romantis spontan atau foto kegiatan di sela waktu luang.
* **🎙️ Interaksi Suara Dua Arah (Voice Note / PTT)**:
  * **Kirim Voice Note Asli**: Menghasilkan pesan suara WhatsApp PTT (bergelombang hijau) menggunakan ElevenLabs Text-to-Speech berkualitas tinggi (suara wanita lembut Indonesia).
  * **Transkripsi Voice Note Masuk**: Otomatis mentranskripsikan VN kiriman pengguna menjadi teks menggunakan Groq Whisper API dan membalas isinya secara kontekstual.
* **📸 Kirim Foto Selfie Visual**:
  * Menghasilkan foto selfie/kegiatan karakter secara instan menggunakan Pollinations AI dengan prompt visual yang konsisten.
* **🧠 Memori Jangka Panjang & RAG**:
  * Mengekstrak fakta personal pengguna (makanan favorit, hobi, kebiasaan, orang terdekat) ke basis data SQLite / Turso.
  * **Semantic Vector Search (HNSWLib)**: Mengingat kembali topik obrolan masa lalu saat topik tersebut diungkit kembali.
* **🗓️ Pengingat Hari Spesial & Anniversary**:
  * Melacak tanggal jadian (anniversary) dan hari ulang tahun, serta mengirimkan ucapan personal otomatis saat tanggal tersebut tiba.

---

### 3. 📁 `bot-stickerinaja` (WhatsApp Sticker & Media Suite)
> **Bot Pembuat Stiker Berperforma Tinggi** yang dioptimalkan untuk server berspesifikasi hemat memori (512MB RAM Koyeb) dengan antrean proses byte-aware LRU cache, Sharp, dan FFmpeg.

* **🎨 Stiker Engine Mutakhir**:
  * Konversi foto (`!s`) dan video/GIF (`!sgif`) menjadi stiker animasi WebP dengan kompresi cerdas.
  * **Transformasi Bentuk**: Lingkaran presisi (`!scircle`), kotak 1:1 (`!scrop`), dan sudut membulat (`!srounded`).
  * **Efek & Preset**: Vintage, mono, deepfried, glow, blur, sharpen, mirror, rotate, dan transparan.
  * **Meme & Bubble**: Stiker meme teks Impact (`!smeme`), stiker teks instan (`!stext --bg #hex`), quote kartu mutiara (`!quote`), dan rambu/label (`!warning`, `!label`).
  * **Reverse Converter**: Mengubah stiker statis kembali ke gambar (`!toimg`) atau stiker animasi kembali ke GIF/MP4 (`!togif`, `!tomp4`).
  * **Bypass Anti-ViewOnce (`!reveal` / `!rvo`)**: Membuka dan menyimpan media pesan sekali lihat (View Once).
* **🌐 Telegram Sync & Downloader**:
  * **Telegram Sticker Pack Importer (`!tg <link>`)**: Mengunduh seluruh pack stiker dari Telegram dan mengonversinya ke WhatsApp.
  * **Reddit & Giphy Crawler (`!reddit`, `!rmeme`, `!giphy`)**: Menjelajah dan mengubah meme populer internet menjadi stiker otomatis.
  * **Media Downloader (`downloader.js`, `youtube.js`)**: Unduh video/audio TikTok tanpa watermark, Instagram Reels/Postingan, dan YouTube MP3/MP4 (`!play`).
* **👥 Fitur Komunitas & Utilitas**:
  * **Birthday Engine (`birthday.js`)**: Kalender ulang tahun anggota grup dengan auto-takeover ucapan perayaan.
  * **Kenangan Cloudinary (`kenangan.js`)**: Upload arsip foto kenangan grup ke cloud lengkap dengan AI captioning.
  * **Market Intelligence (`fx.js`)**: Update kurs USD/IDR live dengan analisis konteks teknikal.
  * **PDF Multi-Page Scanner (`pdf.js`)**: Menggabungkan kumpulan foto dokumen menjadi 1 file PDF utuh.
  * **Kamus & Kalender**: Integrasi KBBI resmi (`!kbbi`), penanggalan weton Jawa/Hijriah, dan jadwal libur nasional.

---

### 4. 📁 `bot-turfpeak` (Flash Peak TMS - Tournament Management System)
> **Sistem Manajemen Turnamen Esports Profesional** berbasis WhatsApp untuk mengelola babak penyisihan grup hingga babak gugur (*Knockout Bracket*).

* **🏆 Operasional & Regulasi Turnamen**:
  * `!createtournament`: Inisialisasi turnamen format grup + sistem gugur.
  * `!draw [size=4|5]`: Undian grup otomatis dan penyusunan jadwal matchday yang adil.
  * `!addteam`, `!teams`, `!roster`: Pendaftaran tim, pengecekan pemain inti/cadangan, dan pembagian info room (`!karturoom`).
  * `!standings`: Klasemen langsung per grup (P, W, D, L, GF, GA, GD, Poin).
  * `!schedule` / `!jadwal` / `!matchday`: Jadwal laga resmi per tim atau ronde.
  * `!rule` / `!regulasi`: Buku aturan resmi kompetisi.
* **📸 Verifikasi Hasil Laga & Babak Gugur**:
  * **Automated Screenshot OCR Verification**: Memindai tangkapan layar hasil akhir pertandingan untuk memvalidasi skor secara akurat.
  * `!approve`, `!confirm`, `!reject`: Hak otorisasi panitia untuk mengesahkan draf skor.
  * `!claimwo` / `!wo`: Klaim kemenangan WO jika tim lawan tidak hadir.
  * `!startknockout`: Otomatis menyusun bagan babak gugur berdasarkan posisi tim di klasemen grup.
  * `!kogame`, `!kores`: Pemasukan dan koreksi skor babak knockout.
  * `!awards`: Rekapitulasi gelar Juara, Top Scorer, dan Best Goalkeeper.
* **🤖 Asisten AI Turnamen**:
  * `!ai`: Asisten tanya-jawab "Omak Peak" yang memahami seluruh konteks turnamen.
  * `!agent`, `!agentconfirm`: Perencanaan aksi administratif otomatis berbasis bahasa alami.
  * `!saveqna`: Ekstraksi pasangan tanya-jawab dari obrolan grup ke FAQ hidup turnamen.
  * `!trivia` & `!pantun`: Kuis 15 detik turnamen dan pantun jenaka komunitas.

---

### 5. 📁 `bot-wirtz-rag` (Personality Chatbot Dialek Jawa Slang)
> **Chatbot Kloning Persona** santai yang menirukan gaya percakapan nyata dialek Jawa slang dengan bantuan Semantic Vector Search RAG.

* **🎭 Persona Khas**: Menirukan gaya bicara, diksi, humor, dan gaya ketikan santai sahabat.
* **📐 Vector Semantic Search RAG (Cohere v3)**:
  * Memetakan pesan input ke ruang vektor 768 dimensi menggunakan model `embed-multilingual-v3.0`.
  * Melakukan pencarian kemiripan kosinus (*Cosine Similarity*) pada database vektor pra-komputasi (`vectors.bin`, `vectors_norm.bin`) untuk mengambil konteks pesan masa lalu yang paling relevan.
* **🧠 DeepSeek LLM Engine**: Menghasilkan respon natural yang kontekstual dengan memadukan persona dan data RAG.
* **☁️ Turso Session Sync**: Mengunggah dan menyinkronkan seluruh kredensial auth Baileys ke Turso SQLite Cloud sehingga bot dapat di-redeploy di cloud tanpa scan ulang QR code.

---

### 6. 📁 `bot-godmode-ai` (AI Security & Jailbreak Research)
> **Bot WhatsApp untuk Riset Keamanan LLM** yang berfokus pada evaluasi ketahanan filter model terhadap teknik Boundary Inversion dan transformasi sintaks.

* **⚔️ 33 Parseltongue Transformation Techniques**: Skrip Python (`parseltongue.py`) yang mengeksekusi 33 metode obfusikasi dan restrukturisasi prompt untuk menguji respon model.
* **🛡️ Refusal Detection & Escalation**: Otomatis mendeteksi penolakan (*refusal*) dari model dan meningkatkan derajat eskalasi teknik obfusikasi secara berjenjang.
* **🔄 Multi-Model Key Rotation & Fallback**: Rotasi otomatis akun kunci DeepSeek dan failover instan ke Mistral AI jika terjadi error atau sensor.
* **💾 Cloud Memory Turso**: Penyimpanan riwayat 30 pesan per percakapan dengan auto-prune berkala untuk evaluasi performa teknik.

---

### 7. 📁 `bot-cloud-agent` (Cloud-Native Autonomous Agent 24/7)
> **Jembatan Agen Otonom WhatsApp** yang berjalan tanpa henti (24/7) di cloud Koyeb free tier dengan orkestrasi model multi-provider dan integrasi pencarian web.

* **🌉 Baileys 7 WebSocket Bridge**: Jembatan handal menggunakan Baileys (`7.0.0-rc.9`) yang menghubungkan obrolan WhatsApp ke framework agen mandiri (*Nanobot*).
* **🔍 Native Web Search via Perplexity**: Model Perplexity `sonar` dan `sonar-pro` bawaan yang mampu menjelajahi web secara real-time saat pengguna meminta riset.
* **🔑 Rotasi 5 Kunci API DeepSeek**: Rotasi otomatis 5 API key untuk menjaga kelancaran reasoning tanpa kendala limit kuota harian.
* **⚡ Multi-Provider Fallback Priority**:
  1. Perplexity Sonar (Pencarian Web & Riset)
  2. DeepSeek (Penalaran Rumit)
  3. Groq (Kecepatan Eksekusi)
  4. Qwen (Cadangan Alternatif)
* **📦 Supabase Storage Persistence**: Otomatis mem-backup dan me-restore seluruh direktori sesi, kredensial WhatsApp, dan workspace agen dalam bentuk arsip zip ke Supabase Storage setiap kali container me-restart.

---

## 🚀 Panduan Memulai (Quick Start)

### Prasyarat
1. **Node.js** v20 atau lebih baru.
2. **Git** terinstall.
3. **FFmpeg** terpasang di sistem (wajib untuk stiker animasi dan konversi audio):
   * *Windows*: `winget install Gyan.FFmpeg`
   * *Linux*: `sudo apt update && sudo apt install -y ffmpeg`

### Cara Menjalankan Salah Satu Bot
Pilih bot yang ingin Anda jalankan, masuk ke direktori bot tersebut, instal dependensi, atur file `.env`, lalu jalankan:

```bash
# Contoh menjalankan bot-multifungsi:
cd bot-multifungsi
npm install

# Buat file konfigurasi dari template:
cp .env.example .env
# Edit .env sesuai API key dan nomor WhatsApp Anda

# Jalankan bot:
node index.js
```

Pindai kode QR yang muncul di terminal menggunakan aplikasi WhatsApp di ponsel Anda (**Perangkat Tertaut > Tautkan Perangkat**).

---

## 🔒 Catatan Keamanan & Privasi
* Repositori ini **tidak menyimpan kredensial sesi, API key, atau token rahasia**.
* Selalu gunakan file `.env.example` sebagai referensi konfigurasi dan jangan pernah meng-commit file `.env` asli atau folder sesi (`auth_info/`, `session/`) ke git publik.

---

## 📄 Lisensi
Seluruh kode dalam repositori ini dirilis di bawah lisensi [MIT License](LICENSE).
