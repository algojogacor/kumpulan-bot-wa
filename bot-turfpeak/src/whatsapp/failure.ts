/**
 * Flash Peak TMS - AI Failure Response Formatter (Task 6.4)
 * 
 * Standardized AI failure message formatter per PROMPT_CATALOG.md §9 and FR-FAIL-002.
 * 
 * Mandatory Rules:
 * 1. Must clearly state automated processing is temporarily unavailable.
 * 2. Must clearly state report has NOT been confirmed, accepted, rejected, or made official.
 * 3. Must direct participants to tournament organizer for manual verification.
 * 4. Never invent numbers, guess match outcome, or make claims about match status.
 */

export interface AIFailureMessageOptions {
  language?: 'id' | 'en' | 'both';
  sessionId?: string;
  fixtureCode?: string;
  organizerPhone?: string;
  includeAdminCommandHint?: boolean;
}

/**
 * Standard English failure text verbatim from PROMPT_CATALOG.md §9
 */
export const STANDARD_FAILURE_TEXT_EN = [
  'Automated screenshot processing is temporarily unavailable.',
  'The report has not been confirmed or changed.',
  'Please contact the tournament organizer for manual verification.',
].join('\n');

/**
 * Standard Indonesian failure text adhering to PROMPT_CATALOG.md §9
 */
export const STANDARD_FAILURE_TEXT_ID = [
  '⚠️ *Pemrosesan Tangkapan Layar Otomatis Sementara Tidak Tersedia*',
  '',
  'Laporan pertandingan belum dikonfirmasi atau diubah.',
  'Status pertandingan TIDAK resmi, TIDAK diterima, dan TIDAK ditolak.',
  'Silakan hubungi penyelenggara turnamen untuk verifikasi manual.',
].join('\n');

/**
 * Formats an AI failure notification message for WhatsApp.
 */
export function formatAIFailureMessage(options: AIFailureMessageOptions = {}): string {
  const lang = options.language ?? 'id';
  const lines: string[] = [];

  if (lang === 'en') {
    lines.push(STANDARD_FAILURE_TEXT_EN);
  } else if (lang === 'both') {
    lines.push(STANDARD_FAILURE_TEXT_ID);
    lines.push('');
    lines.push('─── English ───');
    lines.push(STANDARD_FAILURE_TEXT_EN);
  } else {
    lines.push(STANDARD_FAILURE_TEXT_ID);
  }

  // Optional contextual reference
  const refs: string[] = [];
  if (options.fixtureCode) {
    refs.push(`Pertandingan: *${options.fixtureCode}*`);
  }
  if (options.sessionId) {
    refs.push(`Sesi: \`${options.sessionId.slice(0, 8)}\``);
  }
  if (refs.length > 0) {
    lines.push('');
    lines.push(`📌 ${refs.join(' | ')}`);
  }

  // Optional organizer contact
  if (options.organizerPhone) {
    lines.push('');
    lines.push(`📞 Kontak Penyelenggara: wa.me/${options.organizerPhone.replace(/\D/g, '')}`);
  }

  // Optional Admin hint
  if (options.includeAdminCommandHint) {
    lines.push('');
    lines.push('_Admin dapat memasukkan hasil manual menggunakan command *!manualreport*_');
  }

  return lines.join('\n');
}

export interface AIRetryMessageOptions {
  sessionId?: string;
  fixtureCode?: string;
  attemptNumber?: number; // 1-based retry attempt that just failed
  maxRetries?: number; // total retry attempts allowed
  retryDelayMs?: number; // delay before the next attempt
  nextRetryAt?: Date; // absolute time of the next attempt (preferred over delay)
}

/**
 * Notification sent while an automatic AI retry is pending (provider outage,
 * AllProvidersFailedError). Distinct from the terminal failure message: this one
 * tells participants the system is still trying, so they should NOT resend yet.
 */
export function formatAIRetryPendingMessage(options: AIRetryMessageOptions = {}): string {
  const lines: string[] = [];
  const attempt = options.attemptNumber ?? 1;
  const maxRetries = options.maxRetries ?? 3;

  lines.push('⏳ *Laporan Kamu Masih Diproses*');
  lines.push('');
  lines.push(
    'Server AI sementara tidak dapat dijangkau (semua penyedia sedang tidak merespons). ' +
      `Sistem akan mencoba ulang secara otomatis (percobaan ulang ke-${attempt} dari ${maxRetries}).`
  );
  lines.push('');
  lines.push(
    '✍️ *Mohon tidak mengirim ulang screenshot* — laporan kamu tetap tersimpan dan akan diproses otomatis.'
  );

  if (options.nextRetryAt) {
    const iso = options.nextRetryAt.toISOString();
    lines.push(`🕒 Percobaan ulang berikutnya: sekitar \`${iso.slice(11, 19)} UTC\`.`);
  } else if (options.retryDelayMs) {
    lines.push(`🕒 Percobaan ulang berikutnya: sekitar ${Math.round(options.retryDelayMs / 1000)} detik lagi.`);
  }

  const refs: string[] = [];
  if (options.fixtureCode) {
    refs.push(`Pertandingan: *${options.fixtureCode}*`);
  }
  if (options.sessionId) {
    refs.push(`Sesi: \`${options.sessionId.slice(0, 8)}\``);
  }
  if (refs.length > 0) {
    lines.push('');
    lines.push(`📌 ${refs.join(' | ')}`);
  }

  return lines.join('\n');
}

export interface AIExhaustedMessageOptions extends AIFailureMessageOptions {
  attemptNumber?: number; // last retry attempt that failed (1-based)
}

/**
 * Terminal notification after the automatic retry queue is exhausted: all
 * providers failed on every attempt. This is the point where manual
 * verification by the organizer genuinely becomes necessary (FR-FAIL-002).
 */
export function formatAIRetriesExhaustedMessage(options: AIExhaustedMessageOptions = {}): string {
  const lines: string[] = [];

  lines.push('🛑 *Pemrosesan Otomatis Gagal — Verifikasi Manual Diperlukan*');
  lines.push('');
  const attempt = options.attemptNumber;
  if (attempt !== undefined) {
    lines.push(
      `Sistem sudah mencoba memproses laporan ini sebanyak ${attempt + 1} kali ` +
        '(termasuk percobaan otomatis ulang) dan seluruh penyedia AI tetap tidak dapat dijangkau.'
    );
  } else {
    lines.push(
      'Sistem sudah mencoba memproses laporan ini beberapa kali dan seluruh penyedia AI tetap tidak dapat dijangkau.'
    );
  }
  lines.push('');
  lines.push('Laporan pertandingan belum dikonfirmasi atau diubah.');
  lines.push('Status pertandingan TIDAK resmi, TIDAK diterima, dan TIDAK ditolak.');
  lines.push('Silakan hubungi penyelenggara turnamen untuk verifikasi manual.');

  const refs: string[] = [];
  if (options.fixtureCode) {
    refs.push(`Pertandingan: *${options.fixtureCode}*`);
  }
  if (options.sessionId) {
    refs.push(`Sesi: \`${options.sessionId.slice(0, 8)}\``);
  }
  if (refs.length > 0) {
    lines.push('');
    lines.push(`📌 ${refs.join(' | ')}`);
  }

  if (options.organizerPhone) {
    lines.push('');
    lines.push(`📞 Kontak Penyelenggara: wa.me/${options.organizerPhone.replace(/\D/g, '')}`);
  }

  if (options.includeAdminCommandHint) {
    lines.push('');
    lines.push('_Admin dapat memasukkan hasil manual menggunakan command *!manualreport*_');
  }

  return lines.join('\n');
}

export interface UnreadableEvidenceMessageOptions {
  sessionId?: string;
  fixtureCode?: string;
  reason?: string; // concrete detail: which screen / what the AI could not read
}

/**
 * Notification for the case where the AI DID respond but the submitted evidence
 * itself could not be read (UNREADABLE classification, missing main match
 * screenshot, or extraction/validation failure). The fix is on the participant's
 * side (resend a clearer screenshot), NOT an outage — the message must never
 * claim providers are unavailable.
 */
export function formatUnreadableEvidenceMessage(options: UnreadableEvidenceMessageOptions = {}): string {
  const lines: string[] = [];

  lines.push('📷 *Screenshot Tidak Dapat Dibaca*');
  lines.push('');
  lines.push(
    'AI berhasil merespons, namun data pertandingan tidak dapat diambil dari screenshot yang kamu kirim ' +
      '(kemungkinan foto kurang jelas, terpotong, atau bukan halaman skor akhir).'
  );
  lines.push('');
  lines.push(
    '🔄 *Mohon kirim ulang screenshot skor akhir yang lebih jelas* (lengkap, tidak terpotong, pencahayaan baik).'
  );

  if (options.reason) {
    lines.push('');
    lines.push(`🔍 Detail: ${options.reason}`);
  }

  const refs: string[] = [];
  if (options.fixtureCode) {
    refs.push(`Pertandingan: *${options.fixtureCode}*`);
  }
  if (options.sessionId) {
    refs.push(`Sesi: \`${options.sessionId.slice(0, 8)}\``);
  }
  if (refs.length > 0) {
    lines.push('');
    lines.push(`📌 ${refs.join(' | ')}`);
  }

  return lines.join('\n');
}

export interface GoalkeeperSuspendedMessageOptions {
  sessionId?: string;
  fixtureCode?: string;
}

/**
 * Notification when participant submits a goalkeeper / player detail screenshot.
 * Explains that goalkeeper statistics & awards are currently suspended by tournament
 * regulations, so goalkeeper screenshots do not need to be submitted.
 */
export function formatGoalkeeperSuspendedMessage(options: GoalkeeperSuspendedMessageOptions = {}): string {
  const lines: string[] = [];

  lines.push('🧤 *Statistik Kiper Tidak Perlu Dikirim (Ditangguhkan)*');
  lines.push('');
  lines.push(
    'Halo! Screenshot skor akhir pertandingan (main match summary) tidak terdeteksi di laporan ini, melainkan terdeteksi sebagai statistik Kiper / detail pemain.'
  );
  lines.push('');
  lines.push(
    '📌 *Pemberitahuan Panitia:* Penghargaan *Best Goalkeeper* saat ini telah *DITANGGUHKAN* untuk season ini (karena keterbatasan tampilan game Flash Peak & kesulitan verifikasi statistik save kiper).'
  );
  lines.push('');
  lines.push('Oleh karena itu:');
  lines.push('• Foto/screenshot statistik kiper *sudah tidak perlu dikirimkan lagi*.');
  lines.push('• Mohon kirim ulang screenshot skor akhir pertandingan (tampilan akhir 4v4 lengkap) jika kamu belum melapor.');
  lines.push('• Jika skor akhir sudah dilaporkan sebelumnya, silakan cek draf di grup dan ketik *!approve* untuk menyetujui.');

  const refs: string[] = [];
  if (options.fixtureCode) {
    refs.push(`Pertandingan: *${options.fixtureCode}*`);
  }
  if (options.sessionId) {
    refs.push(`Sesi: \`${options.sessionId.slice(0, 8)}\``);
  }
  if (refs.length > 0) {
    lines.push('');
    lines.push(`📌 ${refs.join(' | ')}`);
  }

  return lines.join('\n');
}
