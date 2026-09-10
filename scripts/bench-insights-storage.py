"""Local SQLite comparison of #1289 and event-only storage (no production I/O).
Run: python3 scripts/bench-insights-storage.py > /tmp/insights-storage.json
"""
import json
import math
import platform
import sqlite3
import statistics
import sys
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "ef1a071e83fc870038a591b7b83d91a6a738f96c"
EVENT_ONLY = "dfee6cb63e6cf6d79a03453284d2417f2c1600db"
SCHEMA = "plugins/cloudflare/worker/migrations/0001_hot-updater_1.0.0.sql"
LATEST = """NOT EXISTS (SELECT 1 FROM bundle_events n WHERE n.install_id=e.install_id
AND (n.received_at_ms>e.received_at_ms OR (n.received_at_ms=e.received_at_ms AND n.id>e.id)))"""

def event(installation, sequence, depth):
    kind = ["UNCHANGED", "UPDATE_DOWNLOADED", "UPDATE_DOWNLOADED", "UPDATE_APPLIED", "RECOVERED"][sequence % 5]
    return dict(id=f"00000000-0000-7000-8000-{installation * 1000 + sequence:012d}",
                type=kind, install_id=f"install-{installation:06d}",
                user_id=None if installation % 11 == 0 else f"user-{(installation + sequence // 4) % 25}",
                from_release_id=None, to_release_id=None,
                from_bundle_id=None if kind == "UNCHANGED" else "A",
                to_bundle_id="B", platform="ios" if installation % 3 else "android",
                app_version="1.0.0", channel="preview" if sequence % 7 == 0 else "production",
                received_at_ms=sequence * 10000 + installation,
                username=None, cohort="0", update_strategy=None if kind == "UNCHANGED" else "appVersion",
                fingerprint_hash=None, sdk_version="1.0.0-rc")

def measure(db, sql, args):
    plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, args)]
    def query():
        deadline = time.perf_counter() + 10
        db.set_progress_handler(lambda: int(time.perf_counter() > deadline), 1000)
        try:
            return db.execute(sql, args).fetchall()
        finally:
            db.set_progress_handler(None, 0)
    try:
        expected = query()
    except sqlite3.OperationalError as error:
        if str(error) != "interrupted": raise
        return None, dict(timed_out_after_ms=10000, plan=plan)
    timings = []
    for _ in range(7):
        started = time.perf_counter()
        try:
            assert query() == expected
        except sqlite3.OperationalError as error:
            if str(error) != "interrupted": raise
            return expected, dict(timed_out_after_ms=10000, plan=plan)
        timings.append((time.perf_counter() - started) * 1000)
    return expected, dict(p50_ms=round(statistics.median(timings), 3),
                         p95_ms=round(sorted(timings)[math.ceil(.95*len(timings))-1], 3),
                         plan=plan)

results = []
for installations, depth in [(1000,10),(1000,100),(10000,10),(10000,100)]:
    dataset = dict(installations=installations, events_per_install=depth, strategies={})
    answers = {}
    for strategy in ["baseline", "event_only"]:
        print(f"{installations} x {depth}: {strategy}", file=sys.stderr, flush=True)
        with tempfile.TemporaryDirectory(prefix="insights-bench-") as folder:
            db = sqlite3.connect(str(Path(folder) / "events.db"))
            revision = BASE if strategy == "baseline" else EVENT_ONLY
            sql = subprocess.check_output(["git", "show", f"{revision}:{SCHEMA}"], cwd=ROOT).decode()
            db.executescript(sql)
            samples = []
            started = time.perf_counter()
            db.execute("BEGIN")
            for i in range(installations):
                # Ten hot installations retain twice the usual history.
                for seq in range(depth * (2 if i < 10 else 1)):
                    row = event(i, seq, depth)
                    candidate = {key:row[key] for key in ["install_id","id","user_id","username","to_bundle_id","type","platform","app_version","channel","cohort","received_at_ms"]}
                    candidate.update(pending_bundle_id=None, pending_release_id=None)
                    if row["type"] == "UPDATE_DOWNLOADED":
                        candidate.update(to_bundle_id=row["from_bundle_id"],pending_bundle_id=row["to_bundle_id"])
                    if strategy == "event_only":
                        row["metadata"] = json.dumps({key:row.pop(key) for key in ["username","cohort","update_strategy","fingerprint_hash","sdk_version"]},separators=(",",":"))
                    tick = time.perf_counter()
                    db.execute(f"INSERT INTO bundle_events ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",list(row.values()))
                    if strategy == "baseline":
                        db.execute(f"INSERT OR REPLACE INTO bundle_installations ({','.join(candidate)}) VALUES ({','.join('?' for _ in candidate)})",list(candidate.values()))
                    if i % 100 == 0: samples.append((time.perf_counter()-tick)*1000)
            db.commit()
            load_ms = (time.perf_counter()-started)*1000
            db.execute("ANALYZE")
            table = "bundle_installations e" if strategy == "baseline" else "bundle_events e"
            latest = "1=1" if strategy == "baseline" else LATEST
            def select(where, count=False):
                return f"SELECT {'COUNT(*)' if count else 'e.id'} FROM {table} WHERE {latest} AND {where}"
            queries = {
                "exact": (select("e.install_id=?")+" ORDER BY e.install_id LIMIT 1",["install-000500"]),
                "user_first": (select("e.user_id=?")+" ORDER BY e.install_id LIMIT 101",["user-1"]),
                "user_later": (select("e.user_id=? AND e.install_id>?")+" ORDER BY e.install_id LIMIT 101",["user-1","install-000500"]),
                "scope_count": (select("e.platform='ios' AND e.channel='production' AND e.received_at_ms>=0",True),[]),
            }
            if strategy == "baseline":
                queries["bundle_count"]=(select("e.platform='ios' AND e.channel='production' AND e.to_bundle_id='B' AND e.received_at_ms>=0",True),[])
            else:
                # Core supplies two predicates to one native count.
                queries["bundle_count"]=(select("e.platform='ios' AND e.channel='production' AND e.received_at_ms>=0 AND ((e.type='UPDATE_DOWNLOADED' AND e.from_bundle_id='B') OR (e.type IN ('UNCHANGED','UPDATE_APPLIED','RECOVERED') AND e.to_bundle_id='B'))",True),[])

            measurements = {}
            for name, (query,args) in queries.items():
                answer, measurement = measure(db,query,args)
                if strategy == "baseline": answers[name]=answer
                elif answer is not None: assert answer == answers[name],(installations,depth,name)
                measurements[name]=measurement
            dataset["strategies"][strategy] = dict(load_ms=round(load_ms),
                append_in_transaction_p50_ms=round(statistics.median(samples),3),
                append_in_transaction_p95_ms=round(sorted(samples)[math.ceil(.95*len(samples))-1],3),
                database_bytes=Path(folder,"events.db").stat().st_size,
                indexes=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('bundle_events','bundle_installations')")],
                queries=measurements)
            db.close()
    results.append(dataset)
print(json.dumps(dict(baseline=BASE,event_only=EVENT_ONLY,sqlite=sqlite3.sqlite_version,host=platform.platform(),
    notes="One process, serial warm reads, 7 samples; p95 is max. Each query attempt has a 10-second measurement cap; interrupted queries report a lower bound, not a partial result. Bulk load has one transaction; not network latency, per-event durable commit cost, or provider billing.",results=results),indent=2))
