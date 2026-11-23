#!/usr/bin/env python3
"""
Manual roster correction for team 'Elite 8'.

The AI roster extractor stripped the 'E8' prefix from every Elite 8 player
nickname because the prefix looked like a number bullet (E + 8) rather than
a clan tag with a formal separator (|, ・, •, _).  This script restores the
canonical in-game nicknames with the 'E8 ' prefix, recomputes the derived
nickname_search_key, records an audit event, and verifies the result.

Run ONLY after a DB backup has been made.
"""
import sqlite3
import sys
import json
import unicodedata
from datetime import datetime, timezone

DB_PATH = "/home/azureuser/flashpeak-tms/local.sqlite"
TEAM_NAME = "Elite 8"
ACTOR_ID = "165210883154071@lid"   # Arya (organizer)
REASON = ("Manual roster correction: AI roster extractor stripped the 'E8' "
          "in-game clan prefix from every Elite 8 player nickname because it "
          "resembled a number bullet. Restored canonical nicknames with "
          "'E8 ' prefix so goal-scorer matching against match photos will work.")


def to_search_key(nick: str) -> str:
    """Reproduce the bot's search_key normalization: lowercase + strip all
    non-ASCII-alphanumeric characters (matches observed DB pattern, e.g.
    '7SB_Nübel' -> '7sbnbel', 'AVO丨Ciboyy〆' -> 'avociboyy')."""
    nfc = unicodedata.normalize("NFC", nick).strip().lower()
    return "".join(ch for ch in nfc if ch.isalnum() and ord(ch) < 128)


# Canonical nicknames with E8 prefix (the delegasi's original intent)
NEW_NICKNAMES = {
    1: "E8 FRIZZ",       # GK
    2: "E8 TikaGemoy",
    3: "E8 ZKYY",
    4: "E8 Nrill",
    5: "E8 Kabuto",
    6: "E8 PoCer`s",     # substitute
    7: "E8 Marta",       # substitute
    8: "E8 Cookiessss",  # substitute
}


def main() -> int:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.isolation_level = None  # autocommit; we'll use explicit BEGIN/COMMIT
    cur = con.cursor()

    # Resolve team
    row = cur.execute(
        "SELECT id, team_name FROM teams WHERE team_name = ?", (TEAM_NAME,)
    ).fetchone()
    if not row:
        print(f"ERROR: team '{TEAM_NAME}' not found")
        return 2
    team_id = row["id"]
    print(f"Team resolved: {row['team_name']} -> {team_id}")

    # Fetch current players (before state) for audit
    before = {}
    for r in cur.execute(
        "SELECT id, roster_slot, nickname_raw, nickname_nfc, nickname_search_key "
        "FROM players WHERE team_id = ? ORDER BY roster_slot",
        (team_id,),
    ):
        before[r["roster_slot"]] = dict(r)
    print(f"\nBEFORE (current DB state):")
    for slot, p in sorted(before.items()):
        print(f"  slot {slot}: raw={p['nickname_raw']!r}  search_key={p['nickname_search_key']!r}")

    if len(before) != 8:
        print(f"\nWARNING: expected 8 players, found {len(before)}. Aborting.")
        return 3

    # Build UPDATE plan + show diff
    plan = []
    print(f"\nDIFF plan:")
    for slot, new_raw in sorted(NEW_NICKNAMES.items()):
        old = before[slot]
        new_nfc = unicodedata.normalize("NFC", new_raw)
        new_key = to_search_key(new_raw)
        plan.append((old["id"], slot, new_raw, new_nfc, new_key, old))
        changed = (
            old["nickname_raw"] != new_raw
            or old["nickname_nfc"] != new_nfc
            or old["nickname_search_key"] != new_key
        )
        mark = "CHANGE" if changed else "no-op"
        print(f"  slot {slot} [{mark}]: {old['nickname_raw']!r} -> {new_raw!r}  "
              f"(search_key {old['nickname_search_key']!r} -> {new_key!r})")

    if "--apply" not in sys.argv:
        print("\nDRY RUN. Re-run with --apply to commit changes.")
        con.close()
        return 0

    # Apply inside a single transaction
    cur.execute("BEGIN")
    try:
        for (pid, slot, new_raw, new_nfc, new_key, old) in plan:
            cur.execute(
                "UPDATE players SET nickname_raw = ?, nickname_nfc = ?, "
                "nickname_search_key = ?, updated_at = ? WHERE id = ?",
                (new_raw, new_nfc, new_key, now, pid),
            )

        # Audit event
        import uuid
        cur.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, actor_id, event_type, entity_type, entity_id, "
            " before_json, after_json, reason, correlation_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                "ORGANIZER",
                ACTOR_ID,
                "ROSTER_MANUAL_CORRECTION",
                "TEAM",
                team_id,
                json.dumps({"players": list(before.values())}, ensure_ascii=False),
                json.dumps({"players": NEW_NICKNAMES}, ensure_ascii=False),
                REASON,
                f"manual-fix-elite8-{now}",
                now,
            ),
        )
        cur.execute("COMMIT")
    except Exception as e:
        cur.execute("ROLLBACK")
        print(f"ERROR during update, rolled back: {e}")
        return 4

    # Verify
    print("\nAFTER (verify):")
    for r in cur.execute(
        "SELECT roster_slot, nickname_raw, nickname_nfc, nickname_search_key "
        "FROM players WHERE team_id = ? ORDER BY roster_slot",
        (team_id,),
    ):
        print(f"  slot {r['roster_slot']}: raw={r['nickname_raw']!r}  "
              f"nfc={r['nickname_nfc']!r}  search_key={r['nickname_search_key']!r}")

    print("\nAudit event recorded. Audit row:")
    ar = cur.execute(
        "SELECT event_type, actor_id, reason, created_at FROM audit_events "
        "WHERE entity_id = ? AND event_type = 'ROSTER_MANUAL_CORRECTION' "
        "ORDER BY created_at DESC LIMIT 1",
        (team_id,),
    ).fetchone()
    if ar:
        print(f"  event_type={ar['event_type']}  actor={ar['actor_id']}")
        print(f"  created_at={ar['created_at']}")
        print(f"  reason={ar['reason']}")

    con.close()
    print("\nDONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
