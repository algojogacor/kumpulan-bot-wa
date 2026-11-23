# 📱 Cara Menggunakan Bot Flash Peak TMS

Panduan lengkap untuk **panitia turnamen** dan **delegasi tim peserta** — ditulis untuk pengguna biasa, bukan programmer. Bot ini hidup di grup WhatsApp dan membantu mengatur turnamen eFootball dari pendaftaran sampai ada juara.

> 💡 **Cara baca panduan ini:** Setiap bagian mengikuti urutan jalannya turnamen. Kalau kamu baru ikut pertama kali, baca dari atas. Kalau sedang di tengah turnamen dan lupa cara sesuatu, lompat langsung ke bagian yang kamu cari lewat judulnya.
>
> 💡 Sedang pegang HP dan butuh ingatan cepat? Ketik `!help` di grup — bot akan menampilkan daftar semua perintah yang boleh kamu pakai (daftar itu menyesuaikan: panitia melihat perintah panitia, delegasi melihat perintah delegasi). Panduan ini adalah versi lengkap + contoh dari daftar itu.

## 🗺️ Gambaran Besar: Alur Turnamen dari Awal sampai Juara

Turnamen Flash Peak berjalan lewat 4 fase besar. Semua diatur lewat grup WhatsApp resmi:

```
1️⃣ PERSIAPAN          → Panitia buat turnamen, daftarkan tim, delegasi diverifikasi
2️⃣ BABAK GRUP         → Undian grup, jadwal main, lapor hasil pertandingan (1 game per pertandingan)
3️⃣ BABAK KNOCKOUT     → Tim lolos bertanding "best-of", kirim foto per game sampai ada pemenang
4️⃣ SELESAI            → Ada juara, rekap penghargaan, turnamen tamat
```

Bedanya babak grup dan babak knockout (poin paling sering bikin bingung):

| | Babak Grup | Babak Knockout |
|---|---|---|
| Bentuk pertandingan | **1 game** sekali main | **Series**: BO3 (menang 2 game dulu) atau Grand Final BO5 (menang 3 game) |
| Cara lapor hasil | Foto hasil game ke grup → AI bot baca → draf laporan → kedua tim + panitia setujui (`!approve`) | **Kirim foto per game** dengan caption `!kogame` → bot catat langsung |
| Kalau game seri | Boleh (poin klasemen 1-1) | **Tidak boleh** — wajib main ulang game yang sama |
| Yang lolos | 2 tim teratas tiap grup | Pemenang tiap pasangan maju, yang kalah pulang |

> ⚠️ **Satu hal yang perlu diingat semua orang:** semua perintah dimulai dengan tanda seru `!` dan diketik **langsung di grup turnamen** (bukan chat pribadi ke bot). Panitia boleh pakai beberapa perintah lewat DM, tapi bagi delegasi: **selalu di grup.**

---

# 1️⃣ Persiapan & Pendaftaran

Bagian ini untuk **panitia**. Kalau kamu delegasi tim, kamu bisa langsung lompat ke bagian "Daftarkan Pemain (Roster)" — tapi tak ada salahnya baca sekilas biar tahu apa yang panitia kerjakan.

> 💡 **Siapa yang dianggap "panitia" oleh bot:** nomor WhatsApp yang terdaftar sebagai organizer di konfigurasi bot (`WA_ORGANIZER_PHONE` / `WA_ORGANIZER_JID`). Perintah khusus panitia (`!createtournament`, `!draw`, `!kores`, `!override`, dsb.) hanya sah kalau dikirim dari nomor itu — tidak peduli nama tampilan atau username WhatsApp kamu. Kalau panitia berganti orang, nomor di konfigurasi bot-lah yang perlu diganti.

## Membuat Turnamen Baru

**Siapa:** Panitia saja.
**Kapan:** Sekali di awal, sebelum tim mendaftar. Turnamen lama harus sudah selesai/diarsipkan dulu.
**Ketik:**

```
!createtournament Flash Peak Championship Season 1
```

(ganti dengan nama turnamen yang kamu mau, bebas)

**Setelah itu:** bot membalas "🏆 TURNAMEN BERHASIL DIBUAT" lengkap dengan **ID turnamen** (contoh: `trn-abc123`). Simpan ID ini — berguna kalau nanti ada beberapa turnamen berjalan dan kamu perlu menyebut turnamen yang mana di `!draw`, `!startknockout`, dsb.

## Menetapkan Grup WhatsApp Resmi

**Siapa:** Panitia saja.
**Kapan:** Sekali di awal — harus di dalam grup yang mau dijadikan grup resmi.
**Ketik (di grup yang dimaksud):**

```
!setgroup
```

**Setelah itu:** bot membalas "Grup ini telah ditetapkan sebagai Grup Resmi Turnamen". Semua pengumuman jadwal, deadline, dan hasil bakal dikirim ke grup ini. Kalau ada dua grup dan kamu salah kirim di grup yang bukan grup resmi, cukup jalankan `!setgroup` lagi di grup yang benar.

## Mendaftarkan Tim

**Siapa:** Panitia saja (delegasi tidak bisa menambah tim sendiri).
**Kapan:** Setelah turnamen dibuat, sebelum undian.
**Ketik:**

```
!addteam Garuda FC
!addteam Singa FC
!addteam Elang United
```

**Setelah itu:** bot membalas "✅ Tim Garuda FC berhasil didaftarkan". Kalau nama tim sudah pernah dipakai, bot menolak dan bilang tim itu sudah ada. Bot juga menampilkan progres: sudah berapa tim masuk dari minimal yang dibutuhkan.

**Penting:** undian butuh **minimal 8 tim**. Kalau kurang, `!draw` akan menolak dan menampilkan progres pendaftaran.

**Cek tim yang sudah masuk** (siapa saja boleh):

```
!tim
```

Bisa juga pakai `!teams`, `!daftartim`, atau `!peserta` — semuanya sama. Bot menampilkan daftar tim, jumlah pemainnya, tanda ✅ (delegasi terverifikasi) atau ⏳ (belum), plus sisa slot (maksimal 16 tim). Contoh:

> 📋 **DAFTAR TIM TERDAFTAR**
> 🏆 Turnamen: **Flash Peak Championship Season 1**
> 📊 Total: **3 / 16 Tim**
> 1. **Garuda FC** (6 pemain) ✅
> 2. **Singa FC** (5 pemain) ⏳
> 3. **Elang United** (6 pemain) ✅

## Verifikasi Delegasi (Onboarding)

**Siapa:** Panitia memulai, lalu **perwakilan tiap tim** ikut serta.
**Kapan:** Setelah semua tim masuk, SEBELUM undian. Ini syarat wajib — tanpa ini `!draw` akan menolak.

**Langkah 1 — Panitia ketik (di grup):**

```
!onboarding
```

**Setelah itu:** bot menampilkan kartu seperti ini, satu per satu untuk tiap tim:

> 📋 **[ONBOARDING DELEGATE RESMI - FLASH PEAK TMS]**
> ⚽ Tim: **Garuda FC**
> 📊 Progres: 1 / 12 tim
> Kepada perwakilan/official delegate dari tim **Garuda FC**, silakan **REPLY / BALAS** pesan ini sekarang untuk mengonfirmasi nomor WhatsApp Anda sebagai delegate resmi.
> ⚠️ **Penting:** Harus menggunakan fitur *Reply/Kutip* pesan ini secara langsung.

**Langkah 2 — Perwakilan Garuda FC membalas (Reply/Kutip) pesan itu** dengan isi apa saja, misal: `hadir, saya delegasi Garuda`.

**Setelah itu:** bot membalas "✅ Konfirmasi Berhasil! Delegate: Budi, Tim: Garuda FC — TERVERIFIKASI" lalu langsung menampilkan kartu tim berikutnya. Beginilah terus sampai semua tim selesai. Panitia tidak perlu mengulang `!onboarding` setiap tim — cukup sekali, bot jalan sendiri tim demi tim. Kalau ada perwakilan yang tidak ada saat itu, panitia bisa ketik `!onboarding` lagi nanti untuk lanjut ke tim yang belum.

**Kenapa ini penting:** setelah terverifikasi, bot tahu nomor WhatsApp kamu = delegasi resmi tim kamu. Semua hak seperti melapor hasil, kirim roster, dan klaim WO hanya jalan buat delegasi terverifikasi. Kalau kamu belum terverifikasi dan coba kirim laporan, bot akan menolak.

## Daftarkan Pemain (Roster)

**Siapa:** Delegasi tim (atau panitia). Ini bagian yang delegasi kerjakan sendiri.
**Kapan:** Setelah onboarding, sebelum atau di awal babak grup. Roster wajib sebelum melapor hasil supaya pencetak gol bisa dicocokkan.
**Ketik:**

```
!roster Garuda FC GK: Ikyy | Inti: Budi, Joko, Doni, Reza | Cadangan: Rian, Kevin
```

Bot juga mengerti tulisan bebas (tanpa format kaku):

```
!roster tim Garuda FC kipernya Ikyy, pemain intinya Budi, Joko, Doni, Reza, cadangannya Rian, Kevin
```

**Aturan jumlah pemain (wajib):** 1 kiper + 4 pemain inti, boleh tambah maksimal 3 cadangan. Lebih dari itu bot menolak.

**Setelah itu:** bot mengkonfirmasi roster tersimpan. Kalau nama pemain tidak dikenali atau jumlah tidak sesuai aturan, bot membalas apa yang kurang/salah.

**Lihat roster tim** (siapa saja boleh, tanpa isi argumen):

```
!roster Garuda FC
```

Bot menampilkan susunan pemain tim itu. Kalau kamu lupa formatnya, ketik `!roster` saja tanpa apa-apa — bot akan menampilkan contoh formatnya.

**Kalau kamu bukan delegasi dan mencoba mendaftar roster untuk tim yang bukan tim kamu:** ditolak oleh bot.

---

# 2️⃣ Undian & Jadwal Babak Grup

## Undian Grup

**Siapa:** Panitia saja.
**Kapan:** Setelah SEMUA tim punya delegasi terverifikasi. Kalau masih ada yang belum, bot menolak undian dan menyuruh `!onboarding` dulu.
**Ketik:**

```
!draw
```
_Atau dengan opsi target ukuran grup:_
```
!draw size=4
!draw size=5
```
*(Default adalah grup target 5 tim; sisa tim diserap grup berisi 4 — contoh: 20 tim → 4 grup × 5, 16 tim → otomatis 4 grup × 4, 9 tim → 1 grup 5 + 1 grup 4. Flag `size=4` berguna kalau Anda ingin grup berisi 4 menjadi target, misal 20 tim → 5 grup × 4. Hanya `4` atau `5` yang sah; kalau jumlah tim tidak mungkin dibentuk dari kombinasi grup 5 dan 4 — misal 11 tim — bot menolak undian dan menyarankan jumlah tim yang cocok).*

**Setelah itu:** bot menampilkan undian SATU TIM PER SATU TIM (ada jeda beberapa detik tiap tim biar seru):

> 🎲 **PENGUNDIAN GRUP — FLASH PEAK CHAMPIONSHIP SEASON 1**
> Undian ke-3 dari 12
> ➡️ Tim: **Singa FC**
> 🎯 Masuk ke: **GRUP B**
> 🔒 _Seed Verifikasi: a3f8c2d1e4b5..._

Setelah semua tim terundi, bot mengirim rangkuman pembagian grup lengkap, lalu otomatis **membuat dan mengumumkan jadwal pertandingan babak grup**. Turnamen resmi berstatus berjalan mulai saat ini.

Undian ini adil dan terkunci — ada "seed verifikasi" yang ditampilkan supaya tidak ada yang curiga hasilnya diutak-atik. Kalau kamu (panitia) mengulang `!draw` saat undian sudah jalan, undian lama dilanjutkan, tidak diulang dari nol.

## Melihat Jadwal

**Siapa:** Semua orang.
**Kapan:** Kapan saja, terutama sebelum main.
**Ketik:**

```
!jadwal
```

(atau `!schedule` — sama saja)

**Setelah itu:** bot menampilkan jadwal lengkap per grup, per ronde:

> 📅 **JADWAL PERTANDINGAN — FLASH PEAK CHAMPIONSHIP SEASON 1**
> 📌 **GRUP A**
>   🔹 **Ronde 1:**
>     ⚽ **Garuda FC** (@62812…) vs **Singa FC** (@62811…) (Host: Garuda FC)
> ...

Catatan penting dari jadwal ini:

- Tim yang namanya di **kiri** adalah **Host Room** — dialah yang buat room dan kartu roomnya dipakai. Contoh di atas: Garuda FC host.
- Nomor @… di samping nama tim adalah nomor delegasi — bot otomatis men-mention keduanya saat mengumumkan deadline.

## Cek Klasemen

**Siapa:** Semua orang.
**Ketik:**

```
!standings A        ← klasemen grup A
!standings B        ← klasemen grup B
```

**Setelah itu:** bot menampilkan tabel klasemen grup itu (main, menang, seri, kalah, poin). Klasemen otomatis diperbarui setiap hasil pertandingan sah tercatat — tidak perlu hitung manual.

> ⚠️ Sebutkan huruf grupnya ya — `!standings` tanpa huruf menampilkan grup A. Kalau kamu lupa grup kamu ada di grup apa, lihat pengumuman undian (`!draw`) atau tanya panitia.

## Cek Status Ronde & Deadline

**Siapa:** Semua orang.
**Ketik:**

```
!matchday
```

(atau `!ronde`)

**Setelah itu:** bot menampilkan status seperti:

> ⏱️ **STATUS MATCHDAY TURNAMEN**
> 🏆 Turnamen: Flash Peak Championship Season 1
> 📌 Ronde Aktif: Ronde 1 (dari total 3 ronde)
> 🕒 Waktu Server Sekarang: 18:12 WIB (20 Nov 2026)
> ⏰ Batas Waktu Harian: Pukul 19:59 WIB
> ⏳ Sisa Waktu Menuju Deadline: 1 jam 47 menit
> 📊 Progres Ronde 1: 2 selesai, 2 belum main

**Batas waktu harian adalah 19:59 WIB.** Pertandingan yang tidak selesai/lapor sampai batas itu akan dievaluasi panitia lewat mekanisme WO (lihat bagian "Kalau Ada Masalah"). Panitia juga bisa memaksa evaluasi batas waktu manual dengan `!matchday cutoff` (hanya panitia) — umumnya dipakai kalau semua match sudah main tapi satu-dua laporan belum masuk.

---

# 3️⃣ Melapor Hasil Pertandingan Babak Grup

Ini bagian paling sering dipakai delegasi, baca teliti.

## Cara Kerjanya (Alur Foto → Draf → Persetujuan)

Di babak grup, laporan hasil JANGAN diketik manual. Alurnya:

1. Selesai main, salah satu delegasi **kirim screenshot hasil pertandingan ke grup** (biasanya halaman skor akhir / statistik). Boleh kirim beberapa foto sekaligus (misalnya foto skor + foto statistik pemain).
2. Bot mendeteksi foto, menyimpannya sebagai bukti, lalu AI-nya membaca isi foto (skor, pencetak gol, statistik pemain).
3. Setelah kamu berhenti kirim foto (jeda beberapa detik), bot membalas dengan **Draf Laporan Pertandingan**.
4. Draf itu harus disetujui **3 pihak**: delegasi tim A, delegasi tim B, dan panitia. Caranya: balas pesan draf dengan `!approve`.
5. Ketika ketiganya sudah setuju → laporan **LOCKED** (sah, tidak bisa diubah), klasemen otomatis terupdate.

> ⏳ Kalau kamu kirim foto lalu sadar ada foto lagi, langsung kirim saja — bot menunggu jeda sejenak (beberapa detik tanpa foto baru) sebelum memproses, supaya semua fotomu terkumpul dalam satu laporan.

## Contoh Dari Awal Sampai Sah

**Delegasi Garuda FC** (habis menang 2-1 lawan Singa FC) kirim foto skor ke grup. Bot membalas draf:

> ⚽ **LAPORAN PERTANDINGAN** _DRAFT_
> ⚔️ Garuda FC vs Singa FC — GRUP A
> **Garuda FC** 2 - 1 **Singa FC**
> 📋 Statistik Garuda FC: Bunny (2 gol), Razorr …
> ⏳ Menunggu persetujuan: **TIM A, TIM B, PANITIA**

**Delegasi Garuda** membalas (Reply) pesan draf itu: `!approve`
Bot: "Vote recorded. Menunggu persetujuan dari: TIM B, ORGANIZER"

**Delegasi Singa FC** membalas draf yang sama: `!approve`
Bot: "Menunggu persetujuan dari: ORGANIZER"

**Panitia** membalas draf: `!approve`
Bot: "Report approved by all three parties and successfully LOCKED." — selesai, klasemen terupdate. 🎉

> 💡 `!approve` tanpa membalas pesan draf juga bisa (bot pakai draf terbaru), tapi **paling aman balas/kutip drafnya** biar tidak salah laporan — apalagi kalau ada beberapa pertandingan berjalan bersamaan.

## Kalau Ada yang Tidak Setuju / Draf Ternyata Salah

Delegasi tidak perlu menyetujui draf yang salah — **cukup JANGAN `!approve`**. Selama 3 pihak belum semuanya setuju, draf tidak akan dikunci. Untuk memperbaiki:

**Balas (Reply) pesan draf** dengan kata-kata bebas yang menyebut masalahnya, misal:

```
koreksi: skor game itu 2-1 bukan 3-1
salah di nama pencetak gol, yang gol dua kali itu Razorr
```

Bot mendeteksi kata kunci seperti *koreksi*, *salah di*, *seharusnya*, *bukan* pada balasan ke draf dan memproses koreksinya. Setelah itu kirim foto yang benar kalau perlu — draf baru akan dibuat dari bukti terbaru dan persetujuan dimulai ulang.

Laporan hanya menjadi sah (LOCKED) ketika **ketiga pihak sudah `!approve`**. Menolak diam-diam (tidak approve) cukup aman: tanpa persetujuanmu laporan tidak akan terkunci.

---

# 4️⃣ Kalau Ada Masalah

Bagian "kalau-kalau" — baca sekilas sekarang, buka lagi saat butuh.

## Lawan Tidak Muncul / Tidak Ada Room (Klaim WO)

**Siapa:** Delegasi tim yang hadir (ajukan), panitia (sahkan).
**Kapan:** Lawan tidak muncul sesuai janji/lewat toleransi waktu, atau menolak jadi host.

Delegasi tim yang hadir ketik:

```
!claimwo <ID_pertandingan> <nama_tim_yang_kalah> <alasan>
```

Contoh:

```
!claimwo fix-wo-1 Singa FC Tidak hadir 10 menit setelah kick-off
```

> ⚠️ Nama tim yang kamu sebut adalah **tim yang KALAH WO** (yang tidak hadir). Lawannya otomatis menang 3–0 (+3 poin). Jangan terbalik.

**Setelah itu:** bot mengirim kartu pengajuan klaim yang menyebut panitia (di-mention):

> 📌 **PENGAJUAN KLAIM WALKOVER (WO)**
> ⚔️ Singa FC melapor: Garuda FC dianggap menang WO
> ⏳ Menunggu Persetujuan Panitia — Balas **!ok** untuk mengesahkan, **!batal** untuk menolak

**Panitia** membalas kartu itu dengan:

```
!ok          ← sahkan, skor 3-0 tercatat, klasemen terupdate
!batal       ← tolak, pertandingan dianggap belum terjadi
```

**PENTING — siapa yang boleh mengajukan:** delegasi tim yang bertanding di pertandingan itu (atau panitia). Delegasi tim lain tidak bisa mengklaim WO atas nama tim lain — bot menolak dengan pesan "Anda bukan delegasi dari tim yang bertanding".

**Cara lain mengajukan (bahasa bebas):** kamu juga bisa ketik dengan bahasa sehari-hari yang diawali `!`, contoh: `!klaim WO untuk Match 1 karena lawan tidak hadir 15 menit`. Bot akan mencoba memahami, mencocokkan pertandingannya (dari nama tim yang kamu sebut / tim terdaftar milikmu), lalu mengeluarkan kartu pengajuan yang sama. Kalau alasan tidak jelas, bot minta ditulis lebih spesifik. Kalau kamu cuma bertanya-tanya "gimana aturan WO", balas bot berisi penjelasan singkat aturan WO tanpa membuat klaim.

**Kalau kamu panitia dan yakin 100%** (misalnya bukti di grup sudah jelas), kamu bisa jalankan `!claimwo` yang sama — tapi karena pengirimnya panitia, **langsung tercatat tanpa menunggu konfirmasi**. Delegasi selalu lewat kartu konfirmasi dulu.

## Kartu Room (Siapa yang Jadi Host)

**Siapa:** Delegasi tim yang bertanding (atau panitia).
**Kapan:** Sebelum mulai main, untuk menetapkan siapa host room; atau saat tim kiri ternyata tidak punya room.

**Cek status host** (cukup ketik):

```
!roomcard fix-wo-1
```

Bot menampilkan host terjadwal, host aktif, dan cara mengubahnya.

**Tetapkan status:**

```
!roomcard fix-wo-1 ok      ← host kiri siap, lanjut main
!roomcard fix-wo-1 ganti   ← host kiri tidak ada room, lawan bersedia gantikan jadi host
!roomcard fix-wo-1 tolak   ← host kiri tidak ada room, lawan MENOLAK menggantikan → lawan menang WO 3-0
!roomcard fix-wo-1 habis   ← KEDUA tim tidak punya kartu room
```

(`!karturoom` dan `!hostroom` juga bisa — sama saja.)

**Apa yang terjadi setelah `habis`:** ini beda antara babak grup dan knockout —

- **Babak grup:** kedua tim kalah WO ganda, skor 0-0, **keduanya dapat 0 poin**, klasemen terupdate.
- **Babak knockout:** kedua tim dinyatakan **kalah ganda** — tidak ada pemenang. Tim yang seharusnya bertemu pemenangnya di ronde berikutnya **otomatis lolos tanpa bertanding (bye)**. Panitia lalu memicu `!startknockout` untuk membentuk ronde berikutnya.

> ⚠️ Setelah pertandingan berstatus SELESAI, status kartu room tidak bisa diubah lagi. ID pertandingan harus ditulis lengkap persis (ID pendek/ salah ketik akan ditolak dengan pesan "tidak ditemukan").

## Salah Kirim Foto / Foto Tidak Terbaca / Salah Baca AI

- **Kirim foto yang salah atau foto dobel:** tidak apa-apa — kirim foto yang benar setelahnya; sistem menghitung jeda foto sebagai satu rangkaian dan foto salah tidak dihitung sebagai hasil resmi.
- **AI gagal membaca / kebingungan membaca foto:** kalau bot membalas dengan kegagalan membaca, kirim ulang foto yang lebih jelas (tidak blur, skor terlihat penuh). Kalau AI-nya benar-benar terkendala, **panitia punya jalur cadangan**: `!manualreport` (lihat bawah).
- **Draf ternyata salah sebelum disetujui semua pihak:** jangan `!approve`. Balas drafnya dengan koreksi (lihat bagian "Kalau Ada yang Tidak Setuju" di atas), lalu kirim foto ulang — draf baru akan dibuat dari bukti yang benar.
- **Laporan salah tercatat tapi SUDAH LOCKED:** panitia buka ulang dengan `!reopen` (lihat bagian koreksi organizer di bawah).

## Laporan Manual oleh Panitia (!manualreport)

**Siapa:** Panitia saja.
**Kapan:** Jalur cadangan kalau foto/AI terkendala — panitia ketik hasilnya langsung.

Format ringkas (bot mencocokkan pencetak gol ke roster):

```
!manualreport fix-001 2-1 A:Bunny,Razorr B:Ikyy
```

Kalau satu pemain bikin >1 gol:

```
!manualreport fix-001 2-1 A:Bunny(2) B:Ikyy
```

Tanpa rincian pencetak (gol dicatat "belum ditugaskan", harus dilengkapi sebelum approve):

```
!manualreport fix-001 2-1
```

**Setelah itu:** bot membuat ringkasan dulu (nama pemain dicocokkan ke roster — kalau ada yang tidak cocok, bot memberitahu) dan menyuruh kamu **balas pesan itu dengan `OK`** untuk lanjut. Setelah kamu balas OK, draf laporan resmi dibuat dan jalan lewat persetujuan 3 pihak seperti biasa (`!approve`).

## Koreksi oleh Panitia (Laporan Sudah Sah/Locked)

**Siapa:** Panitia saja.

**Buka ulang laporan yang sudah terkunci:**

```
!reopen fix-001 skor ternyata salah ketik
```

(ID bisa ID laporan atau ID pertandingan — bot otomatis pakai versi terbaru. Alasan wajib, tercatat di jejak audit.) Setelah dibuka ulang, laporan kembali jadi draf yang bisa dikoreksi dan di-approve ulang.

**Kunci paksa tanpa persetujuan 3 pihak (khusus darurat):**

```
!override fix-001 kedua tim sudah bubar dan hasil sudah disepakati off-record
```

Gunakan hemat — setiap override tercatat dengan alasan di jejak audit. Kalau ada sengketa di kemudian hari, alasan inilah yang jadi pegangan.

---

# 5️⃣ Babak Knockout & Grand Final

Bagian baru — penting dibaca semua delegasi yang timnya lolos, karena caranya BEDA dari babak grup.

## Mulai Babak Knockout

**Siapa:** Panitia saja.
**Kapan:** Setelah SEMUA pertandingan babak grup selesai (termasuk WO/gugurnya). Kalau masih ada yang belum, bot menolak dan menyuruh cek `!matchday`.

```
!startknockout
```

**Setelah itu:** bot mengumumkan fase knockout resmi dimulai — menampilkan tim yang lolos (2 teratas tiap grup) dan bracket pertandingan:

> ⚔️ **FASE KNOCKOUT RESMI DIMULAI**
> 📌 Format: Best of 3 (BO3, first to 2 wins) • Grand Final: Best of 5 (BO5, first to 3 wins)
> 🚫 Tidak ada hasil seri di fase gugur; game seri wajib di-replay pada slot yang sama.
> 🏅 **TIM YANG LOLOS (Top 2 per Grup):** …
> 🎯 **BRACKET PERTANDINGAN:** ⚔️ Garuda FC vs Singa FC (Semifinal 1, BO3) …
> 💡 Tim kiri pada tiap pasangan bertindak sebagai Host Room default. Panitia memicu fase berikutnya dengan !startknockout setelah semua series selesai.

**Konsep kuncinya:**

- Satu "pertandingan" di knockout = **series BO3** (siapa menang 2 game duluan, menang series) atau **Grand Final BO5** (menang 3 game duluan).
- **Lapor per game, satu foto satu game.** Ini beda dari babak grup yang satu foto untuk satu pertandingan.
- **Game tidak boleh seri** — kalau seri, main ulang game yang sama, hasil replay yang dipakai.

## Cara Melapor Hasil Game Knockout (!kogame)

**Siapa:** Delegasi tim yang bertanding (atau panitia).
**Kapan:** Setelah tiap game selesai.

**Kirim screenshot hasil game dengan caption:**

```
!kogame
```

Kalau ada beberapa pertandingan knockout berjalan bersamaan, sebutkan ID pertandingan biar tidak ragu-ragu:

```
!kogame fix-ko-1
```

> ⚠️ Harus **foto + caption** — ketik `!kogame` tanpa foto tidak bisa diproses (bot akan membalas begitu).

**Kalau ada beberapa series aktif dan kamu lupa sebut ID:** bot tidak menebak-nebak. Ia membalas daftar semua series knockout yang sedang aktif (nama kedua tim, ronde, dan ID-nya) dan **tidak mencatat apa pun** — jadi hasil game tidak akan pernah masuk ke pertandingan yang salah. Lihat ID yang benar dari balasan bot itu atau dari `!schedule`, lalu kirim ulang foto dengan caption `!kogame <fixture_id>`. ID yang salah ketik juga ditolak dengan pesan "ID fixture tidak ditemukan".

**Apa yang terjadi setelahnya (contoh nyata):**

Kamu kirim foto game 1: Garuda FC 2-0 Singa FC, caption `!kogame`. Bot membalas:

> ✅ **HASIL GAME KNOCKOUT TERCATAT**
> ⚔️ **Garuda FC** vs **Singa FC** (Semifinal 1, BO3)
> 🎮 Game ke-1: Garuda FC 2 — 0 Singa FC
> 📊 **Skor Series:** 1 — 0
> ➡️ Series belum selesai — kirim screenshot **game ke-2** dengan caption `!kogame`.
> 💡 _BO3: first to 2 wins._

Kamu kirim foto game 2: Garuda FC 1-2 Singa FC. Bot: skor series 1-1, minta game 3.

Game 3: Garuda FC 3-1. Bot membalas:

> 🏆 **HASIL GAME KNOCKOUT TERCATAT — SERIES SELESAI!**
> 🎮 Game ke-3: Garuda FC 3 — 1 Singa FC
> 📊 **Skor Series Final:** 2 — 1
> 🏆 Pemenang series: **Garuda FC** — pertandingan berstatus COMPLETED.

**Kalau game seri** (misal 1-1), bot membalas hasil dicatat tapi **WAJIB REPLAY** di game yang sama:

> 🔁 Game ke-2 seri 1-1 — wajib replay pada slot yang sama. Kirim screenshot hasil replay dengan caption `!kogame`.

Hasil replay otomatis menggantikan hasil seri tadi. Ini normal di knockout — tidak ada yang perlu dihapus manual.

**Kalau kamu bingung mau kirim game keberapa:** sistem selalu mengisi slot yang benar. Foto boleh dikirim tidak berurutan atau terkumpul (misal kamu kirim foto game 3 duluan karena game 2 baru selesai direplay) — slot akan terisi ke tempatnya masing-masing.

**Cek status series kapan saja** (tanpa foto):

```
!kogame fix-ko-1
```

Bot menampilkan skor series berjalan, game berapa yang menunggu hasil, atau pemenangnya kalau sudah selesai.

## Setelah Semua Series Ronde Ini Selesai

Panitia ketik `!startknockout` lagi → bot membentuk pasangan ronde berikutnya dari para pemenang (semi-final → final), dan seterusnya sampai Grand Final.

**Kalau series sudah selesai semua dan panitia belum ketik:** bot membalas daftar series yang belum selesai (kalau masih ada) atau mengumumkan ronde berikutnya. Kalau Grand Final sudah dimainkan dan pemenang sudah keluar, bot menolak dengan sopan: turnamen sudah tuntas.

**Khusus Grand Final (BO5):** saat series final selesai, bot otomatis mengumumkan **JUARA TURNAMEN** dan turnamen berstatus selesai — tanpa perlu `!startknockout` lagi:

> 👑 **JUARA TURNAMEN — FLASH PEAK CHAMPIONSHIP SEASON 1**
> 🏆 Selamat kepada **Garuda FC** sebagai JUARA Flash Peak! 🎉
> 💡 Ketik *!awards* untuk melihat rekap penghargaan akhir.

## Kalau Ada Masalah di Knockout

- **Foto game dobel (kebal/terkirim ulang):** bot membalas "foto ini duplikat hasil game ke-N yang sudah tercatat — tidak dihitung sebagai game baru". Aman, tidak ada hitungan ganda.
- **Foto beda skor / urutan kacau:** sistem selalu mengisi slot game yang benar (slot terbuka pertama), jadi foto tidak pernah "menimpa" hasil yang sudah tercatat. Kalau ada sengketa hasil (mis. skor yang tercatat memang salah), panitia mengoreksinya lewat `!kores` — termasuk mengubah hasil game di series yang sudah selesai.
- **AI tidak terbaca / tidak terkonfigurasi:** bot membalas menyuruh panitia mencatat lewat `!kores`.
- **Kedua tim tidak punya kartu room di knockout:** lihat `!roomcard ... habis` di bagian sebelumnya — kalah ganda, lawan pasangannya di ronde berikutnya dapat **bye otomatis** (lolos tanpa bertanding).
- **Koreksi hasil game oleh panitia** (`!kores`, hanya panitia):

```
!kores fix-ko-1 1 2-0
```

artinya: set game 1 series itu jadi 2-0. Dipakai untuk koreksi salah tercatat, menetapkan hasil game yang "perlu review" (foto bentrok), atau mencatat manual kalau bukti foto tidak terbaca. Bot membalas konfirmasi hasil game dicatat dan skor series terbaru. Kalau series sudah selesai, hasil game yang sama bisa di-rekam ulang lewat perintah yang sama dan series akan dihitung ulang.

---

# 6️⃣ Kalau Turnamen Sudah Selesai

## Rekap Penghargaan

**Siapa:** Semua orang.
**Ketik:**

```
!awards
```

**Setelah itu:** bot menampilkan rekap penghargaan turnamen — Juara, Top Scorer (pencetak gol terbanyak), Best GK (kiper terbaik). Penghargaan dihitung otomatis dari data seluruh pertandingan yang sah.

## Pertanyaan Sehari-hari (Tanpa Hafal Command)

Bot juga mengerti pertanyaan bahasa bebas yang diawali `!` — berguna kalau kamu lupa nama commandnya:

```
!siapa top skor          → rekap penghargaan / top scorer
!lihat klasemen grup A   → klasemen
!apa jadwal hari ini     → status matchday & deadline
!gimana aturannya         → regulasi turnamen (!rule juga bisa)
!susunan pemain Garuda    → roster tim
```

(`!rule` / `!rules` / `!regulasi` menampilkan regulasi resmi lengkap — format turnamen, toleransi waktu, aturan WO, dsb.)

## Tetap Sepakati Sportivitas

Semua yang tercatat bot — foto bukti, hasil, approval, koreksi, bahkan alasan override panitia — tersimpan sebagai jejak audit. Kalau ada sengketa, panitia bisa menelusuri kembali kejadian apa adanya. Foto bukti tidak hilang walau pesan WhatsApp-nya sudah lama tergeser.

---

# 📌 Cheat Sheet Cepat

| Perintah | Boleh dipakai | Fungsi |
|---|---|---|
| `!help` | semua | daftar semua perintah yang kamu boleh pakai |
| `!ping` | semua | cek bot hidup |
| `!id` / `!myid` | semua (DM/grup mana saja) | cek ID WhatsApp Anda & ID grup ini oleh sistem |
| `!tim` / `!peserta` | semua | daftar tim |
| `!roster <tim>` | semua | lihat pemain tim |
| `!standings <grup>` | semua | klasemen (sebut huruf grupnya, mis. `!standings A`) |
| `!jadwal` | semua | jadwal |
| `!matchday` | semua | status ronde + deadline 19:59 WIB |
| `!rule` | semua | regulasi |
| `!awards` | semua | penghargaan |
| `!approve` | delegasi + panitia | setujui draf laporan (balas drafnya) |
| `!roster <tim> GK: ... Inti: ... Cadangan: ...` | delegasi | daftar roster 5+3 |
| `!roomcard <id> ok/ganti/tolak/habis` | delegasi peserta | tetapkan kartu room |
| `!claimwo <id> <tim_kalah> <alasan>` | delegasi peserta | ajukan WO |
| `!kogame` (+foto) | delegasi peserta | lapor hasil game knockout |
| `!createtournament <nama>` | panitia | buat turnamen |
| `!setgroup` | panitia (di grup) | tetapkan grup resmi |
| `!addteam <nama>` | panitia | tambah tim |
| `!onboarding` | panitia | mulai verifikasi delegasi |
| `!draw [size=4\|5]` | panitia | undian grup + jadwal; opsi target ukuran grup (default 5) |
| `!manualreport ...` | panitia | laporan manual |
| `!confirm` / `!ok` / `!batal` | panitia | sahkan / tolak klaim WO & draf |
| `!startknockout` | panitia | mulai / lanjut fase knockout |
| `!kores <id> <game_no> <skor>` | panitia | koreksi hasil game knockout |
| `!reopen <id> <alasan>` | panitia | buka ulang laporan LOCKED |
| `!override <id> <alasan>` | panitia | kunci paksa (darurat) |

### AI-native (update 22 Nov 2026 — D-037..D-040)

| Perintah | Peran | Fungsi |
|---|---|---|
| `!ai <pertanyaan>` | siapa saja | Tanya Omak Peak — asisten AI read-only. Bisa soal turnamen, Flash Peak, atau ngobrol santai. Batas 2x/menit/user. |
| `!qna` | siapa saja | Lihat FAQ hidup (pertanyaan-jawaban yang sudah terkumpul). |
| `!saveqna [n]` | panitia | Ekstrak Q&A dari N pesan terakhir grup (default 10) lewat AI. |
| `!trivia` | siapa saja | Fakta acak soal Flash Peak (dari basis data terverifikasi). |
| `!quiz` | siapa saja | Quiz Flash Peak — pertanyaan dulu, jawaban muncul 15 detik kemudian. |
| `!pantun` | siapa saja | Pantun acak bergaya Flash Peak / turnamen. |
| `!agent <instruksi>` | panitia | AI agent: susun rencana aksi dari instruksi bahasa natural (preview, butuh konfirmasi). |
| `!agentconfirm <kode>` | panitia | Eksekusi rencana yang sudah disusun (idempotent — konfirmasi dobel ditolak eksplisit). |
| `!agentcancel <kode>` | panitia | Batalkan rencana yang masih pending. |

**Catatan Omak Peak:** AI ini read-only — tidak bisa mengubah hasil/jadwal/roster apa pun. Kalau butuh aksi (ubah hasil, reopen, override, dll), pakai command admin di atas atau `!agent` (panitia). Kontak delegasi peserta boleh dibagikan oleh Omak Peak karena memang dibutuhkan untuk kesepakatan match (room host, jadwal).

**Catatan AI Agent (panitia):** Setiap rencana punya kode (mis. `AGENT-7F3K`) dan kedaluwarsa dalam 10 menit. Konfirmasi pakai `!agentconfirm <kode>`. Eksekusi transaksional (all-or-nothing); kalau satu aksi gagal, semua di-rollback. Double-confirm ditolak eksplisit (bukan diabaikan diam-diam). Semua eksekusi tercatat di audit trail.

---

_Panduan ini mengikuti perilaku bot persis seperti kodenya saat ini (termasuk sistem pelaporan knockout per-game). Kalau kamu menemukan perilaku bot yang berbeda dari panduan ini, kabari panitia supaya diperbaiki — bisa jadi ada pembaruan yang belum masuk ke dokumen._
