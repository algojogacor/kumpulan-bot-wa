#!/usr/bin/env bash
# Flash Peak TMS - Log Archive Script
#
# Snapshots the bot logs every run and extracts a clean WhatsApp chat log
# (human-readable) for content creation / tournament archive purposes.
#
# Output layout under $ARCHIVE_ROOT/<YYYY-MM-DD>/:
#   bot-out-<HHMMSS>.log.gz        — raw full bot log (gzipped)
#   bot-error-<HHMMSS>.log.gz       — raw full bot error log (gzipped)
#   chat-<HHMMSS>.txt               — extracted WhatsApp chat (plain, readable)
#   chat-<HHMMSS>.md                — markdown-formatted chat (date headers)
#   manifest.json                   — what was archived this run
#
# Designed to run via cron every 6 hours. Idempotent: re-running same slot
# just creates a new timestamped snapshot. Old snapshots are never deleted
# by this script (no retention / no auto-cleanup) — that is intentional so
# the user's content material is preserved.
set -euo pipefail

PROJECT_DIR="/home/azureuser/flashpeak-tms"
LOG_DIR="$PROJECT_DIR/logs"
ARCHIVE_ROOT="$PROJECT_DIR/archives"

DATE_TAG="$(date -u +%Y-%m-%d)"
TIME_TAG="$(date -u +%H%M%S)"
# WIB = UTC+7. Use WIB timestamp in filenames so they read naturally for the user.
WIB_DATE="$(TZ=Asia/Jakarta date +%Y-%m-%d)"
WIB_TIME="$(TZ=Asia/Jakarta date +%H%M%S)"

DAY_DIR="$ARCHIVE_ROOT/$WIB_DATE"
mkdir -p "$DAY_DIR"

OUT_LOG="$LOG_DIR/bot-out.log"
ERR_LOG="$LOG_DIR/bot-error.log"

# --- 1. Raw log snapshots (gzipped, full copy at this moment) ---
OUT_GZ="$DAY_DIR/bot-out-${WIB_TIME}.log.gz"
ERR_GZ="$DAY_DIR/bot-error-${WIB_TIME}.log.gz"
gzip -c "$OUT_LOG" > "$OUT_GZ"
gzip -c "$ERR_LOG" > "$ERR_GZ"

# --- 2. Extract WhatsApp chat (readable plain text) ---
# Lines we care about look like:
#   2026-11-21T10:20:30: [WA] Inbound msg from 136503103619138@lid in 120363412423738009@g.us: <text>
#   2026-11-21T10:20:30: <continuation line of the same message>
# Also capture bot-out replies if present (lines starting with the same timestamp
# and not [WA] Inbound are usually the message body).
CHAT_TXT="$DAY_DIR/chat-${WIB_TIME}.txt"
CHAT_MD="$DAY_DIR/chat-${WIB_TIME}.md"

# Plain text: keep ONLY [WA] Inbound lines + their immediate continuation lines
# (continuation = a line that does NOT start with "<TS>: " and does NOT look
# like a JSON pino log line "{"level":"). This keeps startup logs and pino
# JSON noise out of the readable chat archive.
awk '
  # Detect start of an inbound WA message
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}: \[WA\] Inbound msg from/ {
    if (in_msg) print "";
    in_msg = 1;
    ts = substr($0, 1, 19);
    rest = substr($0, 21);
    match(rest, /from [0-9]+@lid/);
    phone = substr(rest, RSTART+5, RLENGTH-9);
    match(rest, /in [0-9]+@g\.us/);
    group = substr(rest, RSTART+3, RLENGTH-8);
    match(rest, /: /);
    body = substr(rest, RSTART+2);
    print "[" ts " WIB-UTC] phone=" phone " group=" group;
    print "  " body;
    next;
  }
  # Any other timestamped log line: decide continuation vs end-of-message
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}:/ {
    line_after_ts = substr($0, 21);
    # Trim leading whitespace so patterns like "   [System]" also match.
    trimmed = line_after_ts;
    sub(/^[ \t]+/, "", trimmed);
    # End current message if the line is one of these non-chat log markers.
    if (trimmed ~ /^\{"level":/)                { in_msg = 0; next; }   # pino JSON
    if (trimmed ~ /^\[System\]/)                { in_msg = 0; next; }
    if (trimmed ~ /^\[WA\]/)                    { in_msg = 0; next; }  # other [WA] log tags
    if (trimmed ~ /^\[DB\]/)                   { in_msg = 0; next; }
    if (trimmed ~ /^\[FlashPeak/)              { in_msg = 0; next; }
    if (trimmed ~ /^===/)                      { in_msg = 0; next; }
    if (trimmed ~ /^Connecting to database/)   { in_msg = 0; next; }
    if (trimmed ~ /^Database schema/)          { in_msg = 0; next; }
    if (trimmed ~ /^Initializing Baileys/)     { in_msg = 0; next; }
    if (trimmed ~ /^connected to WA/)          { in_msg = 0; next; }
    if (trimmed ~ /^opened connection/)        { in_msg = 0; next; }
    if (trimmed ~ /^logging in/)               { in_msg = 0; next; }
    if (trimmed ~ /^handled [0-9]+ offline/)   { in_msg = 0; next; }
    if (trimmed ~ /^Connection is now/)        { in_msg = 0; next; }
    if (trimmed ~ /^[0-9]+ pre-keys found/)    { in_msg = 0; next; }
    if (trimmed ~ /^node":\{/)                 { in_msg = 0; next; }
    if (trimmed ~ /^browser":\[/)             { in_msg = 0; next; }
    if (trimmed ~ /^Shutting down/)            { in_msg = 0; next; }
    if (trimmed ~ /^\*+/)                       { in_msg = 0; next; }  # banner lines of asterisks
    # Otherwise: continuation of the previous inbound message body.
    if (in_msg) { print "  " line_after_ts; next; }
    in_msg = 0;
  }
  { in_msg = 0 }
' "$OUT_LOG" > "$CHAT_TXT"

# Markdown: same content, with date headers and code-free formatting.
{
  echo "# Flash Peak TMS — WhatsApp Chat Log"
  echo ""
  echo "- **Tanggal arsip (WIB):** $(TZ=Asia/Jakarta date '+%Y-%m-%d %H:%M:%S')"
  echo "- **Snapshot log:** $OUT_GZ"
  echo "- **Sumber:** \`logs/bot-out.log\`"
  echo ""
  echo "---"
  echo ""
  cur_date=""
  while IFS= read -r line; do
    # Lines starting with [ are chat events
    if [[ "$line" =~ ^\[([0-9]{4}-[0-9]{2}-[0-9]{2})T ]]; then
      d="${BASH_REMATCH[1]}"
      if [[ "$d" != "$cur_date" ]]; then
        echo ""
        echo "## $d"
        echo ""
        cur_date="$d"
      fi
      echo "$line"
    else
      echo "$line"
    fi
  done < "$CHAT_TXT"
} > "$CHAT_MD"

# --- 3. Manifest ---
MANIFEST="$DAY_DIR/manifest.json"
python3 - "$MANIFEST" "$WIB_DATE" "$WIB_TIME" "$OUT_GZ" "$ERR_GZ" "$CHAT_TXT" "$CHAT_MD" "$OUT_LOG" "$ERR_LOG" <<'PY'
import json, os, sys, datetime
manifest_path, wib_date, wib_time, out_gz, err_gz, chat_txt, chat_md, src_out, src_err = sys.argv[1:10]
def sz(p):
    try: return os.path.getsize(p)
    except OSError: return 0
def lines(p):
    try:
        with open(p, 'rb') as f: return sum(1 for _ in f)
    except OSError: return 0
entry = {
    "archive_slot_wib": f"{wib_date} {wib_time[:2]}:{wib_time[2:4]}:{wib_time[4:6]}",
    "archived_at_utc": datetime.datetime.utcnow().isoformat(timespec='seconds') + 'Z',
    "source": {
        "bot_out_log": src_out,
        "bot_error_log": src_err,
        "bot_out_size_bytes": sz(src_out),
        "bot_out_lines": lines(src_out),
        "bot_error_size_bytes": sz(src_err),
        "bot_error_lines": lines(src_err),
    },
    "artifacts": {
        "raw_bot_out_gz": out_gz,
        "raw_bot_error_gz": err_gz,
        "chat_txt": chat_txt,
        "chat_md": chat_md,
        "chat_txt_size_bytes": sz(chat_txt),
        "chat_md_size_bytes": sz(chat_md),
    },
}
# Append to list if manifest exists, else create.
data = []
if os.path.exists(manifest_path):
    try:
        with open(manifest_path) as f: data = json.load(f)
        if not isinstance(data, list): data = []
    except Exception: data = []
data.append(entry)
with open(manifest_path, 'w') as f: json.dump(data, f, indent=2, ensure_ascii=False)
print(f"manifest updated: {manifest_path} ({len(data)} entries)")
PY

echo "Archive done for slot $WIB_DATE $WIB_TIME (WIB)"
echo "  raw out:   $OUT_GZ ($(du -h "$OUT_GZ" | cut -f1))"
echo "  raw err:   $ERR_GZ ($(du -h "$ERR_GZ" | cut -f1))"
echo "  chat txt:  $CHAT_TXT ($(du -h "$CHAT_TXT" | cut -f1))"
echo "  chat md:   $CHAT_MD ($(du -h "$CHAT_MD" | cut -f1))"
