const { saveDB } = require('../helpers/database');

// =================================================================
// 1. KONFIGURASI KEHIDUPAN
// =================================================================
const KONFIG = {
    // LIFE DECAY (Pengurangan Status)
    // 100% / 960 menit = ~0.1
    DECAY_LAPAR: 0.1,        // Habis dalam 16 Jam (Manusiawi)
    DECAY_ENERGI: 0.09,      // Habis dalam 18.5 Jam (Waktu bangun normal)
    DECAY_HP: 0.1,           // Darah berkurang sangat pelan jika lapar (1000 menit untuk mati)
    
    // MODIFIKASI SAAT TIDUR
    SLEEP_REGEN_ENERGI: 0.6, 
    SLEEP_DECAY_LAPAR: 0.02,  // Saat tidur metabolisme lambat (Bisa tahan 3-4 hari)
    
    // HARGA & DENDA (Tetap Sultan)
    BIAYA_MAKAN: 50000000,       
    BIAYA_RS: 500000000,         
    DENDA_MATI: 0.2,           
    
    // LIMIT & PAJAK EKONOMI
    LIMIT_HARIAN: 10000000000,   
    MAX_LOAN: 5000000000,        
    INTEREST_RATE: 0.2,          
    TRANSFER_TAX: 0.05,          
    
    // COOLDOWN
    BANK_COOLDOWN: 10 * 60 * 1000, 
    ROB_COOLDOWN: 30 * 60 * 1000,  
    TIDUR_COOLDOWN: 10 * 60 * 1000 
};;

// =================================================================
// 2. HELPER: UPDATE STATUS
// =================================================================
const updateLife = (user, db, now) => {
    // Init data jika belum ada
    if (typeof user.isSleeping === 'undefined') user.isSleeping = false;
    if (typeof user.hp === 'undefined') user.hp = 100;
    if (typeof user.hunger === 'undefined') user.hunger = 100;
    if (typeof user.energy === 'undefined') user.energy = 100;
    if (typeof user.lastLifeUpdate === 'undefined') user.lastLifeUpdate = now;
    if (typeof user.isDead === 'undefined') user.isDead = false;

    if (db.settings && db.settings.lifeSystem === false) {
        user.lastLifeUpdate = now; return;
    }
    if (user.isDead) return;

    // MENGGUNAKAN MILIDETIK AGAR PRESISI (Bukan Math.floor menit)
    const diffMs = now - user.lastLifeUpdate;
    const diffMinutes = diffMs / 60000; // Biarkan desimal (misal 10.5 menit)

    if (diffMinutes > 0) {
        if (user.isSleeping) {
            // Energi nambah secara halus
            user.energy += diffMinutes * KONFIG.SLEEP_REGEN_ENERGI;
            user.hunger -= diffMinutes * KONFIG.SLEEP_DECAY_LAPAR;

            if (now >= user.sleepEndTime) {
                user.isSleeping = false;
                user.sleepEndTime = 0;
            }
        } else {
            user.hunger -= diffMinutes * KONFIG.DECAY_LAPAR;
            user.energy -= diffMinutes * KONFIG.DECAY_ENERGI;
        }

        // Batas Atas & Bawah
        user.energy = Math.max(0, Math.min(100, user.energy));
        user.hunger = Math.max(0, Math.min(100, user.hunger));

        if (user.hunger === 0) {
            user.hp -= KONFIG.DECAY_HP * diffMinutes; 
        }

        if (user.hp <= 0) {
            user.hp = 0;
            user.isDead = true;
            user.isSleeping = false;
            const denda = Math.floor(user.balance * KONFIG.DENDA_MATI);
            user.balance -= denda;
        }

        // Update waktu terakhir
        user.lastLifeUpdate = now;
    }
};

// =================================================================
// 3. HELPER: BAR PROGRESS (VISUAL)
// =================================================================
const createBar = (current, max = 100) => {
    const active = '█';
    const empty = '░';
    const total = 10;
    const filled = Math.round((current / max) * total);
    return active.repeat(filled) + empty.repeat(total - filled);
};


module.exports = async (command, args, msg, user, db, sock) => {
    const now = Date.now();

    // =================================================================
    // 0. INIT & VALIDASI DASAR
    // =================================================================
    if (typeof user.bank === 'undefined' || isNaN(user.bank)) user.bank = 0;
    if (typeof user.balance === 'undefined' || isNaN(user.balance)) user.balance = 0; 
    if (typeof user.debt === 'undefined' || isNaN(user.debt)) user.debt = 0;
    
    // Init Global Settings
    if (!db.settings) db.settings = { lifeSystem: true };

    // --- JALANKAN UPDATE KEHIDUPAN ---
    updateLife(user, db, now);
    saveDB(db); 

    // Jika Sedang Tidur, tolak semua command KECUALI 'bangun', 'me', 'status'
    const sleepAllowed = ['bangun', 'revive', 'wake', 'me', 'status', 'cekstatus', 'profile'];
    if (user.isSleeping && !sleepAllowed.includes(command)) {
        const sisaMenit = Math.ceil((user.sleepEndTime - now) / 60000);
        return msg.reply(`💤 *Ssstt... Kamu sedang tidur!*\n\nEnergi sedang diisi.\nBangun otomatis dalam: ${sisaMenit} menit.\nKetik \`!bangun\` jika ingin bangun paksa.`);
    }

    // Cek Kematian (Block command jika mati, kecuali revive/status/admin)
    const deadAllowed = ['me', 'status', 'revive', 'rs', 'hidupstatus', 'matistatus'];
    if (user.isDead && !deadAllowed.includes(command)) {
        return msg.reply(`💀 *KAMU PINGSAN/MATI!*\n\nDarahmu habis karena kelaparan/sakit.\nKetik \`!revive\` untuk ke RS (Biaya 💰${KONFIG.BIAYA_RS.toLocaleString()}).`);
    }

    // Init Limit Harian
    const todayStr = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    if (user.lastLimitDate !== todayStr) {
        user.dailyUsage = 0;
        user.lastLimitDate = todayStr;
        saveDB(db);
    }
    if (isNaN(user.dailyUsage)) user.dailyUsage = 0;

    // =================================================================
    // A. ADMIN COMMANDS (Mati/Hidup Status)
    // =================================================================
    if (command === 'matistatus') {
        db.settings.lifeSystem = false;
        saveDB(db);
        return msg.reply("🛑 *SISTEM KEHIDUPAN DIMATIKAN*\nStatus player dibekukan. Aman untuk ditinggal tidur.");
    }

    if (command === 'hidupstatus' || command === 'nyalastatus') {
        db.settings.lifeSystem = true;
        Object.values(db.users).forEach(u => u.lastLifeUpdate = now); // Reset timer semua user
        saveDB(db);
        return msg.reply("▶️ *SISTEM KEHIDUPAN DINYALAKAN*\nWaktu kembali berjalan. Waspada status kalian!");
    }

    // =================================================================
    // B. LIFE COMMANDS (Status, Makan, Tidur, RS)
    // =================================================================
    
    // 1. CEK STATUS (!me)
    if (command === 'me' || command === 'status' || command === 'profile') {
        let txt = `👤 *PROFIL PENGGUNA*\n\n`;
        txt += `Nama: ${msg.author ? `@${msg.author.split('@')[0]}` : 'Kamu'}\n`;
        txt += `❤️ Darah: ${createBar(user.hp)} (${Math.floor(user.hp)}%)\n`;
        txt += `🍗 Lapar: ${createBar(user.hunger)} (${Math.floor(user.hunger)}%)\n`;
        txt += `⚡ Energi: ${createBar(user.energy)} (${Math.floor(user.energy)}%)\n\n`;
        
        txt += `💳 Dompet: 💰${Math.floor(user.balance).toLocaleString()}\n`;
        txt += `🏦 Bank: 💰${Math.floor(user.bank).toLocaleString()}\n`;
        
        if (user.isDead) txt += `\n💀 *STATUS: PINGSAN* (Ketik !revive)`;
        else if (user.hunger < 20) txt += `\n⚠️ *STATUS: KELAPARAN* (Cepat !makan)`;
        else if (user.energy < 20) txt += `\n⚠️ *STATUS: LELAH* (Cepat !tidur)`;
        else txt += `\n✅ *STATUS: SEHAT*`;

        return msg.reply(txt, null, { mentions: [msg.author] });
    }

    // 2. MAKAN (!makan)
    if (command === 'makan' || command === 'eat') {
        if (user.balance < KONFIG.BIAYA_MAKAN) return msg.reply(`❌ Uang kurang! Harga makanan sultan: 💰${KONFIG.BIAYA_MAKAN.toLocaleString()}`);
        if (user.hunger >= 100) return msg.reply(`❌ Kamu masih kenyang!`);

        user.balance -= KONFIG.BIAYA_MAKAN;
        user.hunger = 100; // Langsung kenyang
        user.hp = Math.min(100, user.hp + 10); 
        saveDB(db);

        return msg.reply(`🍽️ *FINE DINING*\nKamu makan hidangan mewah.\n🍗 Lapar: 100%\n❤️ Darah: +10%\n💸 Bayar: 💰${KONFIG.BIAYA_MAKAN.toLocaleString()}`);
    }

    // 3. TIDUR (!tidur)
   if (command === 'tidur' || command === 'sleep') {
        // Cek Durasi (Argumen pertama)
        let durasiJam = parseInt(args[0]);
        if (!args[0]) durasiJam = 1; // Default 1 Jam jika tidak diisi

        // Validasi
        if (isNaN(durasiJam) || durasiJam < 1 || durasiJam > 10) {
            return msg.reply("❌ Durasi tidur minimal 1 jam, maksimal 10 jam.\nContoh: `!tidur 8` (Tidur 8 jam)");
        }
        
        if (user.energy >= 95) return msg.reply("❌ Matamu masih segar bugar (Energi Penuh)!");

        // Set Status Tidur
        user.isSleeping = true;
        user.sleepEndTime = now + (durasiJam * 60 * 60 * 1000); // Konversi Jam ke Milidetik
        saveDB(db);

        return msg.reply(`💤 *ZZZ... SELAMAT TIDUR*\nKamu memutuskan tidur selama *${durasiJam} jam*.\n\n⚡ Energi akan terisi penuh.\n🚫 Lapar berkurang sangat lambat.\n⚠️ Ketik \`!bangun\` jika ada darurat.`);
    }

    // --- TAMBAH COMMAND BANGUN ---
    if (command === 'bangun' || command === 'wake') {
        if (!user.isSleeping) return msg.reply("❌ Kamu sedang tidak tidur.");
        
        user.isSleeping = false;
        user.sleepEndTime = 0;
        saveDB(db);
        
        return msg.reply("☀️ *SELAMAT PAGI*\nKamu bangun tidur. Segera cek status (!me) dan cari sarapan.");
    }

    // 4. REVIVE / RS (!rs)
    if (command === 'revive' || command === 'rs') {
        if (!user.isDead && user.hp > 50) return msg.reply("❌ Kamu masih sehat!");

        // Cek duit (Dompet + Bank)
        const totalUang = user.balance + user.bank;
        
        if (totalUang < KONFIG.BIAYA_RS) {
             // Mode Miskin (BPJS)
             user.isDead = false;
             user.hp = 20; user.hunger = 20; user.energy = 20;
             user.balance = 0; // Ambil sisa uang receh
             saveDB(db);
             return msg.reply("🏥 *BPJS GRATIS*\nKarena kamu miskin, dokter hanya memberimu obat generik. Status kritis.");
        }

        // Bayar (Prioritas Dompet)
        if (user.balance >= KONFIG.BIAYA_RS) {
            user.balance -= KONFIG.BIAYA_RS;
        } else {
            // Kalau dompet kurang, ambil dari bank
            const sisaBayar = KONFIG.BIAYA_RS - user.balance;
            user.balance = 0;
            user.bank -= sisaBayar;
        }

        user.isDead = false;
        user.hp = 100; user.hunger = 100; user.energy = 100;
        saveDB(db);

        return msg.reply(`🏥 *KELUAR DARI RS*\nKamu mendapatkan perawatan VVIP.\n💸 Biaya: 💰${KONFIG.BIAYA_RS.toLocaleString()}\nStatus kembali penuh.`);
    }

    // =================================================================
    // C. ECONOMY COMMANDS (Bank, Depo, Tarik, Transfer, Pinjam)
    // =================================================================

    // 1. BANK
    if (command === 'bank' || command === 'atm' || command === 'dompet') {
        let txt = `🏦 *BANK ARYA* 🏦\n\n`;
        txt += `👤 Nasabah: ${msg.author ? `@${msg.author.split('@')[0]}` : 'Kamu'}\n`;
        txt += `💳 Saldo Bank: 💰${Math.floor(user.bank).toLocaleString()}\n`;
        txt += `👛 Dompet: 💰${Math.floor(user.balance).toLocaleString()}\n`;
        
        if (user.debt > 0) txt += `📉 *Utang:* 💰${Math.floor(user.debt).toLocaleString()}\n`;
        
        // Info Limit Harian
        txt += `\n📊 *Limit Transfer Harian:*\n`;
        txt += `Terpakai: 💰${user.dailyUsage.toLocaleString()} / ${KONFIG.LIMIT_HARIAN.toLocaleString()}\n`;
        
        // Info Status Singkat
        txt += `\n❤️ ${Math.floor(user.hp)}% | 🍗 ${Math.floor(user.hunger)}% | ⚡ ${Math.floor(user.energy)}%`;
        
        return msg.reply(txt, null, { mentions: [msg.author] });
    }

    // 2. DEPOSIT
    if (command === 'depo' || command === 'deposit') {
        const lastBank = user.lastBank || 0;
        if (now - lastBank < KONFIG.BANK_COOLDOWN) {
            const sisa = Math.ceil((KONFIG.BANK_COOLDOWN - (now - lastBank)) / 60000);
            return msg.reply(`⏳ *ANTRIAN PENUH!* Tunggu ${sisa} menit lagi.`);
        }

        if (!args[0]) return msg.reply("❌ Contoh: `!depo 1000` atau `!depo all`");

        let amount = 0;
        if (args[0].toLowerCase() === 'all') {
            amount = Math.floor(user.balance); 
        } else {
            amount = parseInt(args[0].replace(/[^0-9]/g, ''));
        }

        if (isNaN(amount) || amount <= 0) return msg.reply("❌ Nominal tidak valid.");
        if (user.balance < amount) return msg.reply("❌ Uang di dompet kurang!");

        user.balance -= amount;
        user.bank += amount;
        user.lastBank = now;
        saveDB(db);
        return msg.reply(`✅ Sukses setor 💰${amount.toLocaleString()} ke Bank.`);
    }

    // 3. TARIK
    if (command === 'tarik' || command === 'withdraw') {
        const lastBank = user.lastBank || 0;
        if (now - lastBank < KONFIG.BANK_COOLDOWN) {
            const sisa = Math.ceil((KONFIG.BANK_COOLDOWN - (now - lastBank)) / 60000);
            return msg.reply(`⏳ *ANTRIAN PENUH!* Tunggu ${sisa} menit lagi.`);
        }

        if (!args[0]) return msg.reply("❌ Contoh: `!tarik 1000` atau `!tarik all`");

        let amount = 0;
        if (args[0].toLowerCase() === 'all') {
            amount = Math.floor(user.bank); 
        } else {
            amount = parseInt(args[0].replace(/[^0-9]/g, ''));
        }

        if (isNaN(amount) || amount <= 0) return msg.reply("❌ Nominal tidak valid.");
        if (user.bank < amount) return msg.reply("❌ Saldo Bank kurang!");

        user.bank -= amount;
        user.balance += amount;
        user.lastBank = now;
        saveDB(db);
        return msg.reply(`✅ Sukses tarik 💰${amount.toLocaleString()} ke Dompet.`);
    }

    // 4. TRANSFER (Dengan Limit & Pajak)
    if (command === 'transfer' || command === 'tf') {
        const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || msg.mentionedIds || [];
        const targetId = mentions[0];

        if (!targetId || !args[1]) return msg.reply("❌ Format: `!transfer @user 1000`");
        if (targetId === msg.author) return msg.reply("❌ Gak bisa transfer ke diri sendiri.");

        let amount = parseInt(args[1].replace(/[^0-9]/g, ''));
        if (isNaN(amount) || amount <= 0) return msg.reply("❌ Nominal tidak valid.");

        // Cek Limit Harian
        if ((user.dailyUsage + amount) > KONFIG.LIMIT_HARIAN) {
            const sisa = KONFIG.LIMIT_HARIAN - user.dailyUsage;
            return msg.reply(`❌ *LIMIT HABIS!*\nSisa limit hari ini: 💰${sisa.toLocaleString()}`);
        }
        
        // Pajak
        const tax = Math.floor(amount * KONFIG.TRANSFER_TAX);
        const total = amount + tax;

        if (user.balance < total) return msg.reply(`❌ Uang kurang! Butuh 💰${total.toLocaleString()} (Termasuk pajak).`);

        if (!db.users[targetId]) db.users[targetId] = { balance: 0, bank: 0, debt: 0, xp: 0, level: 1 };
        
        user.balance -= total;
        user.dailyUsage += amount;
        db.users[targetId].balance = (db.users[targetId].balance || 0) + amount;
        saveDB(db);

        return msg.reply(`✅ *TRANSFER SUKSES*\n💰 Kirim: ${amount.toLocaleString()}\n💸 Pajak: ${tax.toLocaleString()}\n📉 Sisa Limit: ${(KONFIG.LIMIT_HARIAN - user.dailyUsage).toLocaleString()}`, null, { mentions: [targetId] });
    }

    // 5. PINJAM (Loan)
    if (command === 'pinjam' || command === 'loan') {
        if (user.debt > 0) return msg.reply(`❌ Lunasi dulu utangmu: 💰${user.debt.toLocaleString()}`);
        if (!args[0]) return msg.reply(`❌ Contoh: \`!pinjam 50000000\`\nMax: 💰${KONFIG.MAX_LOAN.toLocaleString()}`);

        let amount = parseInt(args[0].replace(/[^0-9]/g, ''));
        if (isNaN(amount) || amount <= 0) return msg.reply("❌ Nominal salah.");
        if (amount > KONFIG.MAX_LOAN) return msg.reply(`❌ Maksimal pinjaman: 💰${KONFIG.MAX_LOAN.toLocaleString()}`);

        const totalDebt = Math.floor(amount * (1 + KONFIG.INTEREST_RATE));
        
        user.balance += amount;
        user.debt = totalDebt;
        saveDB(db);

        return msg.reply(`🤝 *PINJAMAN CAIR*\n💰 Terima: ${amount.toLocaleString()}\n📉 Total Utang: ${totalDebt.toLocaleString()} (Bunga 20%)`);
    }

    // 6. BAYAR UTANG
    if (command === 'bayar' || command === 'pay') {
        if (user.debt <= 0) return msg.reply("✅ Gak punya utang.");
        
        let amount = 0;
        if (args[0] && args[0].toLowerCase() === 'all') amount = user.debt;
        else amount = parseInt((args[0] || '0').replace(/[^0-9]/g, ''));

        if (amount <= 0) return msg.reply(`❌ Tagihan: 💰${user.debt.toLocaleString()}`);
        if (user.balance < amount) return msg.reply(`❌ Uang kurang!`);
        
        if (amount > user.debt) amount = user.debt;

        user.balance -= amount;
        user.debt -= amount;
        saveDB(db);

        return msg.reply(`💸 *DIBAYAR*\nNominal: 💰${amount.toLocaleString()}\nSisa Utang: 💰${user.debt.toLocaleString()}`);
    }

   // =================================================================
    // 7. TOP PENDAPATAN HARIAN (GROUP ONLY)
    // =================================================================
    if (command === 'top' || command === 'leaderboard' || command === 'dailyrank') {
        const chatId = msg.from || msg.key.remoteJid;
        if (!chatId.endsWith('@g.us')) return msg.reply("❌ Fitur ini hanya untuk Grup!");

        // 1. Ambil Data Member Grup
        let groupMetadata;
        try {
            groupMetadata = await sock.groupMetadata(chatId);
        } catch (e) {
            return msg.reply("⚠️ Gagal mengambil data grup. Pastikan bot admin/koneksi aman.");
        }
        const memberIds = groupMetadata.participants.map(p => p.id);

        // 2. Filter & Sort Berdasarkan DAILY INCOME
        const sorted = Object.entries(db.users)
            .filter(([id, data]) => memberIds.includes(id)) // Hanya user di grup ini
            .map(([id, data]) => ({
                id,
                name: data.name || id.split('@')[0],
                job: data.job || "Pengangguran",
                // Hitung Pendapatan Harian (Kalau undefined anggap 0)
                dailyIncome: data.dailyIncome || 0 
            }))
            .sort((a, b) => b.dailyIncome - a.dailyIncome) // Urutkan dari yang paling cuan hari ini
            .slice(0, 10); // Ambil 10 besar

        // 3. Icon Job Mapping
        const getJobIcon = (job) => {
            const j = job.toLowerCase();
            if (j.includes("petani") || j.includes("tanam")) return "🌾";
            if (j.includes("polisi")) return "👮";
            if (j.includes("dokter") || j.includes("rs")) return "👨‍⚕️";
            if (j.includes("maling") || j.includes("perampok")) return "🥷";
            if (j.includes("tambang") || j.includes("miner")) return "⛏️";
            if (j.includes("karyawan") || j.includes("pabrik")) return "👷";
            return "💼"; // Default
        };

        // 4. Render Tampilan
        let txt = `🏆 *TOP PENDAPATAN HARI INI* 🏆\n(Reset setiap jam 00:00 WIB)\n${"―".repeat(25)}\n\n`;
        
        if (sorted.length === 0 || sorted[0].dailyIncome === 0) {
            txt += "💤 Belum ada yang berpenghasilan hari ini.\nAyo kerja atau nge-rob!";
        } else {
            sorted.forEach((u, i) => {
                // Jangan tampilkan yang pendapatannya 0
                if (u.dailyIncome <= 0) return;

                let medal = '';
                if (i === 0) medal = '🥇';
                else if (i === 1) medal = '🥈';
                else if (i === 2) medal = '🥉';
                else medal = `${i + 1}.`;

                const formattedMoney = u.dailyIncome.toLocaleString('id-ID');
                const jobIcon = getJobIcon(u.job);

                txt += `${medal} @${u.name}\n`;
                txt += `   └ ${jobIcon} ${u.job} | 💸 +Rp ${formattedMoney}\n`;
            });
        }

        // Cek Posisi Sendiri
        const myRank = sorted.findIndex(x => x.id === (msg.author || msg.key.participant));
        const myIncome = (user.dailyIncome || 0).toLocaleString('id-ID');
        
        txt += `\n${"―".repeat(25)}\n👤 *Posisi Kamu: #${myRank + 1}*\n💰 Cuan Hari Ini: Rp ${myIncome}`;

        // Kirim
        return msg.reply(txt);
    }

    // =================================================================
    // D. CRIME COMMAND (Rob)
    // =================================================================
    if (command === 'rob' || command === 'maling') {
        // Cek Energi
        if (user.energy < 10) return msg.reply("⚠️ *TERLALU LELAH*\nEnergimu kurang dari 10%. Tidur dulu (`!tidur`)!");

        const lastRob = user.lastRob || 0;
        if (now - lastRob < KONFIG.ROB_COOLDOWN) {
            const sisa = Math.ceil((KONFIG.ROB_COOLDOWN - (now - lastRob)) / 60000);
            return msg.reply(`👮 Polisi lagi patroli! Tunggu ${sisa} menit lagi.`);
        }

        const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || msg.mentionedIds || [];
        const targetId = mentions[0];

        if (!targetId || targetId === msg.author) return msg.reply("❌ Tag korban yang valid!");

        let targetUser = db.users[targetId];
        if (!targetUser) return msg.reply("❌ Target belum terdaftar.");

        const targetWallet = Math.floor(targetUser.balance || 0);
        if (targetWallet < 1000000) return msg.reply("❌ Target terlalu miskin (Saldo < 1 Juta). Gak worth it.");

        user.energy -= 10; // Kurangi energi

        const chance = Math.random();
        // 40% Berhasil
        if (chance < 0.4) {
            const stolen = Math.floor(targetWallet * 0.2); 
            targetUser.balance -= stolen;
            user.balance += stolen;
user.dailyIncome = (user.dailyIncome || 0) + stolen;
            user.lastRob = now;
            saveDB(db);
            return msg.reply(`🥷 *SUKSES!* Dapat 💰${stolen.toLocaleString()} dari @${targetId.split('@')[0]}\n⚡ Energi -10`, null, {mentions: [targetId]});
        } else {
            // Gagal: Denda 10% Saldo + Gebukin Warga (HP -20)
            const fine = Math.floor(user.balance * 0.10);
            user.balance -= fine;
            user.lastRob = now;
            user.hp -= 20; 
            saveDB(db);
            return msg.reply(`👮 *TERTANGKAP!* Denda 💰${fine.toLocaleString()}\n🤕 Kamu dipukuli warga (HP -20)\n⚡ Energi -10`);
        }
    }
};









