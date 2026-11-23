# 🧠 Flash Peak AI Knowledge Base

Direktori ini berisi seluruh basis pengetahuan (*knowledge base*) otoritatif tentang game **Flash Peak** yang diintegrasikan langsung sebagai konteks prompt AI pada asisten **"Omak Peak"** (`src/application/omak-peak.ts`) dan modul AI prompts (`src/ai/prompts/flashpeak-game-knowledge.ts`).

---

## 📁 Isi File Pengetahuan & Konteks AI

1. **`FLASH_PEAK_CHARACTERS.md`**:
   * Kompendium lengkap profil seluruh karakter Flash Peak (ST, CM, CB, WF, GK).
   * Statistik dasar (Power, Speed, Stamina, Shoot, Pass, Dribble, Defense).
   * Skill kecil (*small skill*), skill pamungkas (*ultimate skill*), dan daftar pasif utama.
   * Panduan taktik, rekomendasi posisi, dan sinergi antarkarakter.

2. **`FLASH_PEAK_SKILLS_AND_ABILITIES.md`**:
   * Dokumentasi mendalam tentang mekanik skill, cooldown, stamina cost, dan formula interaksi fisik.
   * Logika duel bahu (*shoulder barge*), interception, tackle, dan sistem pertahanan penjaga gawang (*goalkeeper mechanics*).

3. **`flash_peak_roster_catalog.json`**:
   * Katalog data JSON terstruktur yang berisi ID karakter, atribut numerik, tier, dan metadata resmi untuk pencarian data instan oleh AI.

4. **`flash_peak_skills_catalog.json`**:
   * Katalog JSON definisi efek skill, pengali damage/power, dan tipe status.

5. **`flashpeak-trivia.json`**:
   * Kumpulan fakta unik, kuis trivia 15 detik, dan database pengetahuan komunitas untuk perintah `!trivia` di WhatsApp grup.

---

## 🔄 Bagaimana AI Menggunakan Pengetahuan Ini?

* **Authoritative Ingestion**: File-file ini diproses dan dirangkum ke dalam `src/ai/prompts/flashpeak-game-knowledge.ts`.
* **Trusted Context Injection**: Saat pengguna menanyakan rekomendasi karakter, counter strategi, jadwal pertandingan, atau tips gameplay melalui perintah `!ai <pertanyaan>`, sistem `OmakPeakService` menyuntikkan data ini bersama status live turnamen (`src/ai/prompts/omak-peak-context.ts`) ke dalam prompt LLM.
* **Akurasi Tinggi**: Memastikan AI tidak berhalusinasi (*zero hallucination*) tentang status karakter, nama skill, atau aturan resmi Flash Peak.
