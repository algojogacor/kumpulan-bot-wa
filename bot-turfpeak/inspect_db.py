#!/usr/bin/env python3
"""Read-only inspection of the Flash Peak TMS production database on the VM."""
import json
import sqlite3

DB = "/home/azureuser/flashpeak-tms/local.sqlite"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()


def rows(sql, args=()):
    try:
        return [dict(r) for r in cur.execute(sql, args).fetchall()]
    except sqlite3.Error as e:
        return [{"ERROR": str(e)}]


print("== TABLE COUNTS ==")
for t in ["tournaments", "delegates", "whatsapp_identities", "teams", "players",
          "groups", "group_members", "group_draws", "fixtures", "series", "games",
          "report_sessions", "report_versions", "standings", "approvals",
          "corrections", "audit_events", "inbound_messages", "media_assets",
          "ko_game_evidence", "provider_usage"]:
    r = rows(f"SELECT COUNT(*) AS n FROM {t}")
    n = r[0].get("n") if r and "n" in r[0] else r
    if n:
        print(f"{t:24s}: {n}")

print("\n== TOURNAMENTS ==")
for t in rows("SELECT id, name, status, created_at, updated_at FROM tournaments ORDER BY created_at"):
    print(json.dumps(t, ensure_ascii=False))

print("\n== TEAMS (dengan status delegasi) ==")
for t in rows("""SELECT tm.team_name, tm.registration_status, tm.created_at,
                        d.display_name AS delegate, tm.delegate_id
                 FROM teams tm LEFT JOIN delegates d ON d.id = tm.delegate_id
                 ORDER BY tm.created_at"""):
    print(json.dumps(t, ensure_ascii=False))

print("\n== PLAYERS per team ==")
for p in rows("""SELECT t.team_name, COUNT(p.id) AS players,
                        SUM(CASE WHEN p.position='GOALKEEPER' THEN 1 ELSE 0 END) AS gk
                 FROM teams t LEFT JOIN players p ON p.team_id = t.id
                 GROUP BY t.id ORDER BY t.created_at"""):
    print(json.dumps(p, ensure_ascii=False))

print("\n== DELEGATES ==")
for d in rows("SELECT id, display_name, status, created_at FROM delegates ORDER BY created_at"):
    print(json.dumps(d, ensure_ascii=False))

print("\n== WHATSAPP IDENTITIES ==")
for w in rows("""SELECT raw_address, address_type, is_primary, delegate_id, verified_at
                 FROM whatsapp_identities ORDER BY created_at"""):
    print(json.dumps(w, ensure_ascii=False))

print("\n== FIXTURES (ringkas) ==")
for f in rows("""SELECT id, round_number, round_code, stage, status,
                        home_team_id, away_team_id
                 FROM fixtures ORDER BY round_number, id LIMIT 30"""):
    print(json.dumps(f, ensure_ascii=False))

print("\n== GROUPS ==")
for g in rows("SELECT * FROM groups ORDER BY id"):
    print(json.dumps(g, ensure_ascii=False))

print("\n== AUDIT EVENTS (20 terakhir) ==")
for a in rows("""SELECT created_at, event_type,
                        substr(coalesce(details_json,''),1,160) AS details
                 FROM audit_events ORDER BY created_at DESC LIMIT 20"""):
    print(json.dumps(a, ensure_ascii=False))

print("\n== INBOUND MESSAGES (10 terakhir) ==")
for m in rows("""SELECT message_timestamp, chat_id, sender_raw_address,
                        message_type, substr(coalesce(text_body, caption,''),1,60) AS txt
                 FROM inbound_messages ORDER BY received_at DESC LIMIT 10"""):
    print(json.dumps(m, ensure_ascii=False))

print("\n== CONFIG turnamen aktif ==")
for c in rows("SELECT id, substr(config_json,1,400) AS cfg FROM tournaments ORDER BY created_at DESC LIMIT 2"):
    print(json.dumps(c, ensure_ascii=False))

con.close()
print("\nDONE (read-only)")
