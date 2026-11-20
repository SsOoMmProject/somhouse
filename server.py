"""Somhouse's small, local-only family API. Python standard library only."""
import argparse
import getpass
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import sqlite3
import subprocess
import threading
import time
from contextlib import closing, contextmanager
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

import ai as assistants
from ai import AIError, Assistants, parse_question, summarize_records, SCOPES
from google_records import (GoogleAPI, GoogleError, GoogleRecords, SCHEMA as GOOGLE_SCHEMA, SCOPES as GOOGLE_SCOPES,
                            load_config as load_google_config, read_config as read_google_config)
from calendar_records import FEEDING_KINDS, SLEEP_KINDS, SCHEMA as CALENDAR_SCHEMA, WritebackRefused, load_aliases, relearn
from shopping_records import SCHEMA as SHOPPING_SCHEMA
from google_delivery import SCHEMA as DELIVERY_SCHEMA
from holidays import HolidayFeed, SCHEMA as HOLIDAY_SCHEMA, listing as holiday_listing
from demo import GUEST, READ_ONLY_MESSAGE, demo_payload
from sleep_wake import end_open_sleep, end_sleep_on_feeding
import google_web
from google_setup import provision
import families
from families import HOME, Refused, Registry, family_of_token, session_prefix
from calendar_records import CALENDAR_SCOPES, WRITE_SCOPE
from keep_sync import (CONFIG_NAME as KEEP_CONFIG_NAME, SCHEMA as KEEP_SCHEMA,
                       KeepSync, configured_email, queue as queue_keep)

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = Path.home() / "Library/Application Support/Somhouse"
DEFAULT_RETURN = "https://ssoommproject.github.io/somhouse/"
KINDS = ("records", "schedule", "shopping")
STATIC = {"index.html", "app.js", "ai-direct.js", "service.js", "shared.js", "config.js", "style.css",
          "manifest.webmanifest", "icon-192.png", "icon-512.png", "about.html", "privacy.html", "terms.html", "ai-keys.html"}
ITERATIONS = 600_000
MAX_BODY = 4 * 1024 * 1024
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256
NO_SESSION_EXPIRY = float("inf")


class Problem(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def validate_item(kind, item):
    if kind not in KINDS or not isinstance(item, dict):
        raise Problem(400, "올바른 기록이 아닙니다.")
    if not all(isinstance(v, str) and len(v) <= 16000 for v in item.values()):
        raise Problem(400, "기록의 값은 16,000자 이하의 문자열이어야 합니다.")
    required = {"records": ["id", "type", "date"], "schedule": ["id", "date", "title"],
                "shopping": ["id", "title", "quantity"]}[kind]
    if kind == "records":
        if item.get("type") not in ("feeding", "hospital", "sleep", "diaper"):
            raise Problem(400, "지원하지 않는 기록 종류입니다.")
        required += {"feeding": ["category", "amount"], "sleep": ["category"], "diaper": ["category"],
                     "hospital": ["hospital", "reason"]}[item["type"]]
        if item["type"] == "diaper" and item["category"] not in DIAPER_KINDS:
            raise Problem(400, "기저귀 종류는 소변·대변·둘 다 중에서 골라 주세요.")
        if item["type"] == "sleep" and (item["category"] not in SLEEP_KINDS
                                        or (item.get("end") and item["end"] <= item["date"])):
            raise Problem(400, "수면 종류와 깬 시각을 확인해 주세요.")
    if any(not item.get(key, "").strip() for key in required) or len(item.get("id", "")) > 200:
        raise Problem(400, "기록의 필수 항목을 확인해 주세요.")
    if kind == "shopping" and item.get("done", "no") not in ("yes", "no"):
        raise Problem(400, "구매 상태가 올바르지 않습니다.")
    return item


def validate_data(data):
    if not isinstance(data, dict) or any(not isinstance(data.get(k), list) for k in KINDS):
        raise Problem(400, "올바른 솜하우스 백업 파일이 아닙니다.")
    if sum(len(data[k]) for k in KINDS) > 50000:
        raise Problem(400, "한 번에 이전할 수 있는 기록 수를 초과했습니다.")
    for kind in KINDS:
        for item in data[kind]:
            validate_item(kind, item)
    return data


def fingerprint(kind, item):
    content = {k: v for k, v in item.items() if k != "id" and v != ""}
    if kind == "shopping":
        content.setdefault("done", "no")
    return hashlib.sha256(encode(content).encode()).hexdigest()


PARENTS = ("가족", "엄마", "아빠")
DIAPER_KINDS = ("소변", "대변", "둘 다")
TIMER_SIDES = ("좌", "우")
MAX_HANDOFF = 200


def local_now():
    """The Mac's local time to the second ("YYYY-MM-DDTHH:MM:SS"); the family's phones share its time zone."""
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def parse_local(value):
    return time.mktime(time.strptime(value, "%Y-%m-%dT%H:%M:%S"))


def timer_feeding(timer, ended):
    """The direct-breastfeeding record a finished timer leaves: start time, total minutes, minutes per side."""
    seconds = {side: 0.0 for side in TIMER_SIDES}
    for segment in timer["segments"]:
        seconds[segment["side"]] += max(0.0, parse_local(segment.get("end") or ended) - parse_local(segment["start"]))
    minutes = {side: round(value / 60) for side, value in seconds.items()}
    total = max(1, round(sum(seconds.values()) / 60))
    sides = " · ".join(f"{side} {minutes[side]}분" for side in TIMER_SIDES if seconds[side] >= 30)
    return {"id": "timer-" + secrets.token_hex(12), "type": "feeding", "date": timer["segments"][0]["start"][:16],
            "category": "모유", "amount": f"{total}분", "memo": ("직수 타이머 · " + sides) if sides else "직수 타이머"}


def valid_children(value):
    """Children's names for '누구 일정': 1~10 unique names of 1~20 characters, not a parent word."""
    if not isinstance(value, list) or len(value) > 10:
        raise Problem(400, "아기 이름은 10명까지 등록할 수 있어요.")
    names = []
    for name in value:
        name = name.strip() if isinstance(name, str) else ""
        if not 0 < len(name) <= 20 or "," in name or name in PARENTS:
            raise Problem(400, "아기 이름을 1~20자로 입력해 주세요. 가족·엄마·아빠는 쓸 수 없어요.")
        if name in names:
            raise Problem(400, f"‘{name}’은 이미 등록돼 있어요.")
        names.append(name)
    return names


def password_text(value):
    if not isinstance(value, str) or not 0 < len(value) <= MAX_PASSWORD_LENGTH:
        return False
    try:
        value.encode()
    except UnicodeError:
        return False
    return True


def valid_new_password(value):
    return password_text(value) and len(value) >= MIN_PASSWORD_LENGTH and bool(value.strip())


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "somhouse.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, salt TEXT NOT NULL, password TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, username TEXT NOT NULL, expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS items(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
                CREATE TABLE IF NOT EXISTS imports(kind TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(kind,fingerprint));
                CREATE TABLE IF NOT EXISTS family_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """ + KEEP_SCHEMA + GOOGLE_SCHEMA + CALENDAR_SCHEMA + SHOPPING_SCHEMA + DELIVERY_SCHEMA + HOLIDAY_SCHEMA)
            for table, column, definition in (
                ("google_voice_receipts", "captured", "TEXT"),
                ("google_calendar_inputs", "review", "INTEGER NOT NULL DEFAULT 0"),
                ("google_calendar_inputs", "etag", "TEXT NOT NULL DEFAULT ''"),
            ):
                if column not in {row[1] for row in db.execute(f"PRAGMA table_info({table})")}:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                    if column == "captured":
                        db.execute("""UPDATE google_voice_receipts SET captured=(
                            SELECT MIN(captured) FROM google_record_events e
                            WHERE e.binding=google_voice_receipts.binding AND e.voice_id=google_voice_receipts.voice_id)""")
                    elif column == "review":
                        db.execute("""UPDATE google_calendar_inputs SET review=COALESCE((
                            SELECT status LIKE '확인 필요%' OR status='웹 기록 유지' FROM google_record_events e
                            WHERE e.binding=google_calendar_inputs.binding AND e.item_id=google_calendar_inputs.item_id
                            AND e.source='calendar' ORDER BY seq DESC LIMIT 1),0)""")
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def settings(db):
        values = {key: json.loads(value) for key, value in db.execute(
            "SELECT key,value FROM family_settings WHERE key IN ('children','handoff','timer')")}
        return {"children": values.get("children", []), "handoff": values.get("handoff"), "timer": values.get("timer")}

    @staticmethod
    def put_setting(db, key, value):
        if value is None:
            db.execute("DELETE FROM family_settings WHERE key=?", (key,))
        else:
            db.execute("INSERT INTO family_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, encode(value)))

    def state(self, db):
        data = {k: [] for k in KINDS}
        for kind, body in db.execute("SELECT kind,body FROM items ORDER BY rowid"):
            data[kind].append(json.loads(body))
        return data

    def snapshot(self, db, *, automatic=True):
        folder = self.directory / "backups"
        folder.mkdir(exist_ok=True, mode=0o700)
        path = folder / (("auto-" if automatic else "") + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(6) + ".json")
        with path.open("x", encoding="utf-8") as file:
            path.chmod(0o600)
            file.write(encode(self.state(db)))
            file.flush()
            os.fsync(file.fileno())
        if automatic:
            self.prune_snapshots(folder, path)
        return path

    @staticmethod
    def prune_snapshots(folder, newest):
        # Explicit backups and legacy filenames are never removed automatically.
        try:
            files = sorted(folder.glob("auto-????????-??????-????????????.json"),
                           key=lambda path: path.stat().st_mtime_ns, reverse=True)
            keep = set(files[:100]) | {newest}
            days = set()
            cutoff = time.time() - 30 * 86400
            for path in files:
                day = path.name[5:13]
                if path.stat().st_mtime >= cutoff and day not in days:
                    keep.add(path)
                    days.add(day)
                if path not in keep:
                    path.unlink()
        except OSError:
            print("자동 백업 정리 실패: 파일 접근 권한과 디스크를 확인해 주세요.", file=sys.stderr, flush=True)

    def password(self, username, password):
        with self.lock, self.connect() as db:
            self.write_password(db, username, password)
            db.execute("DELETE FROM sessions WHERE username=?", (username,))

    @staticmethod
    def write_password(db, username, password):
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
        db.execute("INSERT INTO users VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt,password=excluded.password", (username, salt, digest))

    @staticmethod
    def password_matches(db, username, password):
        row = db.execute("SELECT salt,password FROM users WHERE username=?", (username,)).fetchone()
        salt, expected = row or ("00" * 16, "00" * 32)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
        return row is not None and hmac.compare_digest(expected, digest)

    def login(self, username, password):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not self.password_matches(db, username, password):
                raise Problem(401, "아이디 또는 비밀번호를 확인해 주세요.")
            return {"token": self.new_session(db, username), "username": username, "read_only": username == GUEST,
                    "family": {"home": True, "name": families.HOME_NAME}}

    @staticmethod
    def new_session(db, username, prefix=""):
        token = prefix + secrets.token_urlsafe(32)
        db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), username, NO_SESSION_EXPIRY))
        return token

    def change_password(self, token, current, new):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            username = self.user(db, token)
            if not self.password_matches(db, username, current):
                raise Problem(403, "현재 비밀번호를 확인해 주세요.")
            self.write_password(db, username, new)
            db.execute("DELETE FROM sessions WHERE username=? AND token<>?",
                       (username, hashlib.sha256(token.encode()).hexdigest()))

    def user(self, db, token):
        row = db.execute("SELECT username FROM sessions WHERE token=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if not row:
            raise Problem(401, "로그인이 필요합니다. 다시 로그인해 주세요.")
        return row[0]

    def merge(self, db, data, restore=False):
        # Validate the entire upload before any snapshot or write.
        validate_data(data)
        self.snapshot(db)
        existing = self.state(db)
        seen = {k: {fingerprint(k, x) for x in existing[k]} for k in KINDS}
        imported = {k: {r[0] for r in db.execute("SELECT fingerprint FROM imports WHERE kind=?", (k,))} for k in KINDS}
        added = skipped = 0
        for kind in KINDS:
            for original in data[kind]:
                fp = fingerprint(kind, original)
                if fp in seen[kind] or (not restore and fp in imported[kind]):
                    skipped += 1
                else:
                    item = dict(original)
                    if db.execute("SELECT 1 FROM items WHERE kind=? AND id=?", (kind, item["id"])).fetchone():
                        item["id"] = "import-" + secrets.token_hex(16)
                    db.execute("INSERT INTO items VALUES(?,?,?)", (kind, item["id"], encode(item)))
                    seen[kind].add(fp)
                    added += 1
                db.execute("INSERT OR IGNORE INTO imports VALUES(?,?)", (kind, fp))
        return {"data": self.state(db), "added": added, "skipped": skipped}


class Family:
    """One family's records: the home family uses the server's own store and Google bridge."""

    def __init__(self, family, store, google=None, keep=None):
        self.id, self.store, self.google, self.keep = family, store, google, keep

    @property
    def home(self):
        return self.id == HOME


class FamilyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, origins=(), *, holidays=False):
        super().__init__(address, Handler)
        # Only the real service downloads the public holiday feed; tests and admin commands never do.
        self.holiday_feed = holidays
        self.store = store
        self.ai = Assistants.load(store.directory)
        # Keep valid legacy sessions and discard only sessions that already expired.
        with store.lock, store.connect() as db:
            now = time.time()
            db.execute("DELETE FROM sessions WHERE expires<=?", (now,))
            db.execute("UPDATE sessions SET expires=? WHERE expires<?", (NO_SESSION_EXPIRY, NO_SESSION_EXPIRY))
        port = self.server_port
        self.origins = set(origins) | {"https://ssoommproject.github.io", f"http://127.0.0.1:{port}",
                                       f"http://localhost:{port}", "http://127.0.0.1:8765", "http://localhost:8765"}
        self.failures = []
        self.login_lock = threading.Lock()
        self.google_states = google_web.Pending(600)  # OAuth round trips in progress
        self.login_codes = google_web.Pending(120)    # one-time codes handed back to the web page
        self.google = GoogleRecords.load(store)
        self.keep = KeepSync.load(store) if self.google is None and not (store.directory / "google-records.json").exists() else None
        self.registry = Registry(store)
        self.family_stores = {}
        self.family_lock = threading.Lock()
        # Each other family may connect its own Google account; its bridge works only on that family's folder.
        self.family_bridges = {}
        self.workers = []
        self.running = False
        with store.connect() as db:
            others = [family for family, _ in self.registry.families(db) if family != HOME]
        for family in others:
            bridge = GoogleRecords.load(self.family_store(family))
            if bridge is not None:
                self.family_bridges[family] = bridge

    def start_bridge(self, family, bridge):
        """Use a family's newly connected Google bridge, and start its worker when the server is running."""
        with self.family_lock:
            self.family_bridges[family] = bridge
            running = self.running
        if running:
            self.run_worker(bridge)

    def run_worker(self, bridge):
        thread = threading.Thread(target=bridge.run, daemon=True)
        with self.family_lock:
            self.workers.append(bridge)
        thread.start()

    def google_subject_in_use(self, subject, family):
        """True when another family (or the home family) already connected this Google account."""
        home = read_google_config(self.store.directory) or {}
        if family != HOME and home.get("subject") == subject:
            return True
        with self.store.connect() as db:
            others = [f for f, _ in self.registry.families(db) if f not in (HOME, family)]
        return any((read_google_config(self.store.directory / "families" / f) or {}).get("subject") == subject
                   for f in others)

    def family_store(self, family):
        with self.family_lock:
            if family not in self.family_stores:
                self.family_stores[family] = Store(self.store.directory / "families" / family)
            return self.family_stores[family]

    def family(self, family):
        if family == HOME:
            return Family(HOME, self.store, self.google, self.keep)
        return Family(family, self.family_store(family), self.family_bridges.get(family))

    def family_for(self, token):
        """The family a session token opens. Unknown or removed families need a new sign-in."""
        family = family_of_token(token)
        if family is None:
            raise Problem(401, "로그인이 필요합니다. 다시 로그인해 주세요.")
        if family != HOME:
            with self.store.lock, self.store.connect() as db:
                if not self.registry.exists(db, family):
                    raise Problem(401, "가족 구성이 바뀌었어요. 다시 로그인해 주세요.")
        return self.family(family)

    def family_empty(self, family):
        if family == HOME:
            return False
        store = self.family_store(family)
        # A family with a Google connection (even a half-finished one) is never set aside automatically.
        if (store.directory / "google-records.json").exists():
            return False
        with store.lock, store.connect() as db:
            return db.execute("SELECT 1 FROM items LIMIT 1").fetchone() is None

    def retire_family(self, family):
        """Move the folder of a family that no longer exists aside (it had no records); nothing is deleted."""
        if family == HOME or not families.ID_PATTERN.fullmatch(family):
            return
        with self.family_lock:
            self.family_stores.pop(family, None)
            folder = self.store.directory / "families" / family
            if folder.exists():
                retired = self.store.directory / "families" / ".retired"
                retired.mkdir(parents=True, exist_ok=True, mode=0o700)
                folder.rename(retired / f"{family}-{time.strftime('%Y%m%d-%H%M%S')}")

    def holidays(self, db, family):
        if family.home:
            return holiday_listing(db)
        with self.store.connect() as home:
            return holiday_listing(home)

    def end_sessions(self, family, username):
        store = self.family(family).store
        with store.lock, store.connect() as db:
            db.execute("DELETE FROM sessions WHERE username=?", (username,))

    def serve_forever(self, poll_interval=0.5):
        sync = self.google or self.keep
        if sync is not None:
            threading.Thread(target=sync.run, daemon=True).start()
        with self.family_lock:
            self.running = True
            bridges = list(self.family_bridges.values())
        for bridge in bridges:
            self.run_worker(bridge)
        holidays = HolidayFeed(self.store) if self.holiday_feed else None
        if holidays is not None:
            threading.Thread(target=holidays.run, daemon=True).start()
        try:
            super().serve_forever(poll_interval)
        finally:
            if holidays is not None:
                holidays.stop.set()
            if sync is not None:
                sync.stop.set()
                sync.wake.set()
            for bridge in self.workers:
                bridge.stop.set()
                bridge.wake.set()

    @contextmanager
    def credential_attempt(self, failure_status):
        # A global bound also works behind Funnel, whose requests share loopback IPs.
        with self.login_lock:
            self.failures = [t for t in self.failures if t > time.time() - 60]
            if len(self.failures) >= 10:
                raise Problem(429, "비밀번호 확인 시도가 많습니다. 1분 후 다시 시도해 주세요.")
            try:
                yield
            except Problem as error:
                if error.status == failure_status:
                    self.failures.append(time.time())
                raise


class Handler(BaseHTTPRequestHandler):
    server_version = "Somhouse/1"

    def log_message(self, *_):
        pass  # Never log credentials, tokens, or family records.

    def respond(self, status, value, mime="application/json; charset=utf-8"):
        body = encode(value).encode() if mime.startswith("application/json") else value
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Vary", "Origin")
        if self.headers.get("Origin") in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            # Let the browser reuse one preflight for 10 minutes: each one costs seconds over the public relay.
            self.send_header("Access-Control-Max-Age", "600")
        if status == 429:
            self.send_header("Retry-After", "60")
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()

    def return_target(self, value):
        """Only a page on an allowed web origin may receive the result of a Google round trip."""
        try:
            parts = urlsplit(value)
        except (TypeError, ValueError):
            return DEFAULT_RETURN
        origin = f"{parts.scheme}://{parts.netloc}"
        return origin + (parts.path or "/") if isinstance(value, str) and origin in self.server.origins else DEFAULT_RETURN

    def google_start(self):
        store, body = self.server.store, self.body(4096)
        client = google_web.load_web_client(store.directory)
        if client is None:
            raise Problem(503, "관리자가 맥에서 Google 웹 로그인을 먼저 설정해야 해요.")
        mode, state = body.get("mode"), {"return": self.return_target(body.get("returnTo"))}
        if mode == "connect":
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer ") or len(auth) > 200:
                raise Problem(401, "로그인이 필요합니다.")
            family = self.server.family_for(auth[7:])
            with family.store.lock, family.store.connect() as db:
                if family.store.user(db, auth[7:]) == GUEST:
                    raise Problem(403, READ_ONLY_MESSAGE)
            if family.home and family.google is None:
                raise Problem(409, "처음 연결은 관리자가 맥에서 해야 해요. 연결된 뒤부터 여기서 다시 연결할 수 있어요.")
            state["session"] = hashlib.sha256(auth[7:].encode()).hexdigest()
            state["family"] = family.id
            # Another family always asks for Calendar too (Nest voice usually lands there), so a family that
            # left it out at first can add the feeding calendar by reconnecting.
            calendar = True if not family.home else family.google.calendar
            scopes = GOOGLE_SCOPES + (CALENDAR_SCOPES if calendar else ())
        elif mode == "login":
            scopes = google_web.LOGIN_SCOPES
            invite = body.get("invite")
            if isinstance(invite, str) and 0 < len(invite) <= 100:
                state["invite"] = invite
        else:
            raise Problem(400, "로그인 방식을 확인해 주세요.")
        state.update(mode=mode, verifier=secrets.token_urlsafe(48))
        key = self.server.google_states.add(state)
        return {"url": google_web.authorization_url(client, key, state["verifier"], scopes, offline=mode == "connect")}

    def google_callback(self):
        store = self.server.store
        params = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
        state = self.server.google_states.take(params.get("state"))
        back = state["return"] if state else DEFAULT_RETURN
        fail = lambda message: self.redirect(back + "#google-error=" + quote(message))
        if state is None:
            return fail("Google 로그인 시간이 지났어요. 다시 시도해 주세요.")
        if "code" not in params:
            return fail("Google 로그인을 취소했어요.")
        client = google_web.load_web_client(store.directory)
        connected = read_google_config(store.directory) or {}
        try:
            tokens = google_web.exchange(client, params["code"], state["verifier"])
            who = google_web.identity(tokens["access_token"])
        except (GoogleError, KeyError, TypeError):
            return fail("Google 로그인을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.")
        if not isinstance(who.get("sub"), str) or not who["sub"] or who.get("email_verified") is not True:
            return fail("이메일이 확인된 Google 계정으로 로그인해 주세요.")
        if state["mode"] == "login":
            # Which family this account opens: the connected home account, an invite, a pre-registered
            # address, an existing membership, or else a new empty family of its own.
            registry = self.server.registry
            try:
                with store.lock, store.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    previous, _ = registry.membership(db, who["sub"])
                    family, username, outcome = registry.sign_in(
                        db, who["sub"], who.get("email"), state.get("invite"), connected.get("subject"),
                        self.server.family_empty)
                    name = registry.name(db, family)
            except Refused as refused:
                return fail(refused.message)
            if outcome == "moved":
                self.server.retire_family(previous)
            target = self.server.family(family).store
            with target.lock, target.connect() as db:
                token = target.new_session(db, username, session_prefix(family))
            code = self.server.login_codes.add({"token": token, "username": username, "outcome": outcome,
                                                "family": {"home": family == HOME, "name": name}})
            return self.redirect(back + "#google=" + code)
        # Connect or reconnect: the person who started it must still be signed in to that family.
        family_id = state.get("family", HOME)
        with store.lock, store.connect() as db:
            known = self.server.registry.exists(db, family_id)
        family = self.server.family(family_id) if known else None
        row = None
        if family is not None:
            with family.store.lock, family.store.connect() as db:
                row = db.execute("SELECT username FROM sessions WHERE token=?", (state["session"],)).fetchone()
        if not row or row[0] == GUEST:
            return fail("다시 로그인한 뒤 Google 연결을 다시 시도해 주세요.")
        if not family.home:
            connected = read_google_config(family.store.directory) or {}
        if family.google is None:
            return self.first_connect(family, client, tokens, who, connected, fail, back)
        if not family.home:
            return self.reconnect_family(family, client, tokens, who, connected, fail, back)
        if not connected.get("subject") or who["sub"] != connected["subject"]:
            return fail("이 가족에 연결된 Google 계정으로 다시 연결해 주세요.")
        google = family.google
        if not tokens.get("refresh_token"):
            return fail("Google이 계속 연결 권한을 주지 않았어요. 모든 권한에 체크하고 다시 시도해 주세요.")
        trial = {**google.config, "client_id": client["client_id"], "client_secret": client["client_secret"],
                 "refresh_token": tokens["refresh_token"]}
        try:
            google_web.check_access(trial, tokens["access_token"], bool(google.calendar))
        except (GoogleError, KeyError, TypeError):
            return fail("새 연결로 기존 시트·Tasks·캘린더를 읽지 못해 이전 연결을 유지했어요. 모든 권한에 체크했는지 확인해 주세요.")
        # Writing back to the original Calendar event needs the owned-events scope; Google lets people untick it.
        extra = {"calendar_write": WRITE_SCOPE in str(tokens.get("scope", "")).split()} if google.calendar else {}
        google.adopt_credentials(client["client_id"], client["client_secret"], tokens["refresh_token"],
                                 tokens["access_token"], extra)
        return self.redirect(back + "#google-connected=1")

    def first_connect(self, family, client, tokens, who, previous, fail, back):
        """Another family's first Google connection from a phone: its own Tasks list, source sheet and calendar.

        The bridge then reads that account's voice inputs (Tasks @default, primary calendar) into this family only.
        """
        if family.home:
            return fail("처음 연결은 관리자가 맥에서 해야 해요.")
        if previous.get("subject") and previous["subject"] != who["sub"]:
            return fail("처음 연결하던 Google 계정과 같은 계정으로 다시 시도해 주세요.")
        if self.server.google_subject_in_use(who["sub"], family.id):
            return fail("이 Google 계정은 이미 다른 가족에 연결돼 있어요. 이 가족이 쓰는 Google 계정으로 연결해 주세요.")
        if not tokens.get("refresh_token"):
            return fail("Google이 계속 연결 권한을 주지 않았어요. 모든 권한에 체크하고 다시 시도해 주세요.")
        granted = set(str(tokens.get("scope", "")).split())
        if not set(GOOGLE_SCOPES[2:]) <= granted:
            return fail("Google Tasks와 Drive(솜하우스가 만든 파일만) 권한이 필요해요. 모든 권한에 체크하고 다시 시도해 주세요.")
        calendar = set(CALENDAR_SCOPES) <= granted  # unticked Calendar: Tasks and the sheet still work
        config = {**previous, "binding": previous.get("binding") or secrets.token_hex(16),
                  "client_id": client["client_id"], "client_secret": client["client_secret"],
                  "refresh_token": tokens["refresh_token"], "inbox": previous.get("inbox", "@default"),
                  "subject": who["sub"]}
        if calendar:
            config["calendar_write"] = True
        try:
            provision(family.store.directory, GoogleAPI(config, tokens["access_token"]), config, calendar)
        except (GoogleError, KeyError, TypeError, ValueError, OSError):
            return fail("Google에 솜하우스 시트·Tasks·캘린더를 만들지 못했어요. 다시 연결하면 만든 것까지 이어서 진행해요.")
        bridge = GoogleRecords(family.store, config)
        with family.store.lock, family.store.connect() as db:
            bridge.backfill(db)  # records saved before connecting go to the new sheet, Tasks and calendar
        self.server.start_bridge(family.id, bridge)
        return self.redirect(back + "#google-connected=" + ("new" if calendar else "new-no-calendar"))

    def reconnect_family(self, family, client, tokens, who, connected, fail, back):
        """Another family's reconnect: renew the grant, add the calendar if newly allowed, and remake a sheet,
        Tasks list or feeding calendar the family deleted (the bridge then resends what lived there)."""
        if not connected.get("subject") or who["sub"] != connected["subject"]:
            return fail("이 가족에 연결된 Google 계정으로 다시 연결해 주세요.")
        if not tokens.get("refresh_token"):
            return fail("Google이 계속 연결 권한을 주지 않았어요. 모든 권한에 체크하고 다시 시도해 주세요.")
        granted = set(str(tokens.get("scope", "")).split())
        if not set(GOOGLE_SCOPES[2:]) <= granted:
            return fail("Google Tasks와 Drive(솜하우스가 만든 파일만) 권한이 필요해요. 모든 권한에 체크하고 다시 시도해 주세요.")
        calendar = set(CALENDAR_SCOPES) <= granted
        if not calendar and connected.get("calendar_outbox"):
            return fail("이 가족은 수유 캘린더를 쓰고 있어요. 캘린더 권한까지 모두 체크하고 다시 연결해 주세요.")
        config = {**connected, "client_id": client["client_id"], "client_secret": client["client_secret"],
                  "refresh_token": tokens["refresh_token"]}
        if calendar:
            config["calendar_write"] = True
        try:
            made = provision(family.store.directory, GoogleAPI(config, tokens["access_token"]), config, calendar,
                             recreate=True)
        except (GoogleError, KeyError, TypeError, ValueError, OSError):
            return fail("Google의 솜하우스 시트·Tasks·캘린더를 확인하지 못해 이전 연결을 유지했어요. 잠시 후 다시 시도해 주세요.")
        family.google.renew(config, tokens["access_token"], made)
        return self.redirect(back + "#google-connected=" + (",".join(sorted(made)) if made else "1"))

    def body(self, max_size=MAX_BODY):
        if self.headers.get("Transfer-Encoding"):
            raise Problem(400, "지원하지 않는 요청 형식입니다.")
        if self.headers.get_content_type() != "application/json":
            raise Problem(415, "JSON 형식으로 요청해 주세요.")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > max_size:
                limit = "4MB" if max_size == MAX_BODY else f"{max_size // 1024}KB"
                raise Problem(413, f"요청 크기는 {limit} 이하여야 합니다.")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, UnicodeError):
            raise Problem(400, "올바른 JSON 요청이 아닙니다.")

    def ai_request(self, token):
        ai = self.server.ai
        family = self.server.family_for(token)
        store = family.store
        if self.command == "GET":
            with store.lock, store.connect() as db:
                guest = store.user(db, token) == GUEST
            # `enabled` says whether this account can ask; each provider says whether it is connected.
            status = {"providers": ai.status(), "enabled": bool(ai.connected())}
            if not family.home:
                # The Mac's AI accounts answer for the original family only; other
                # families connect their own API keys on their devices instead.
                providers = [{**provider, "enabled": False} for provider in status["providers"]]
                return {"providers": providers, "enabled": False, "homeOnly": True}
            return {**status, "enabled": False, "readOnly": True} if guest else status

        # Read the small body before taking the lock, but check the session
        # before validating it so signed-out callers only ever see 401.
        body = self.body(24 * 1024)
        summary = None
        with store.lock, store.connect() as db:
            username = store.user(db, token)
            if username == GUEST:
                raise Problem(403, READ_ONLY_MESSAGE)
            if not family.home:
                raise Problem(403, "AI 대화는 아직 기본 가족만 쓸 수 있어요.")
            question, scope = parse_question(body)
            name = body.get("provider")
            if name is None:
                connected = ai.connected()
                if not connected:
                    raise Problem(503, "관리자가 맥미니에 AI CLI를 연결해야 해요.")
                provider = connected[0]
            elif not isinstance(name, str) or name not in ai.providers:
                raise Problem(400, "질문할 AI를 확인해 주세요.")
            else:
                provider = ai.providers[name]
            if not provider.binary:
                raise Problem(503, f"관리자가 맥미니에 {provider.name} CLI를 연결해야 해요.")
            if scope != "none":
                if not provider.allow_summaries:
                    raise Problem(403, "관리자가 가족 기록 집계 전송을 활성화해야 해요.")
                items = [json.loads(row[0]) for row in db.execute(
                    "SELECT body FROM items WHERE kind=?", (SCOPES[scope],))]
                summary = summarize_records(scope, items, date.today())
        # Release the SQLite connection and lock before waiting for the AI company.
        return ai.answer(username, provider, question, scope, summary)

    @staticmethod
    def save_item(db, store, google, keep, kind, item):
        """Store one item (backup first). A feeding also ends the open sleep; both go to Google or Keep."""
        body = encode(item)
        store.snapshot(db)
        db.execute("INSERT INTO items VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
                   (kind, item["id"], body))
        woke = None
        if kind == "records":
            relearn(db, item)
            woke = end_sleep_on_feeding(db, item)
        if google is not None:
            google.queue(db, kind, item["id"], item, "save")
            if woke:
                google.queue(db, "records", woke["id"], woke, "save")
        elif keep is not None:
            queue_keep(db, keep.email, kind, item["id"], body)
            if woke:
                queue_keep(db, keep.email, "records", woke["id"], encode(woke))
        return woke

    @staticmethod
    def queue_change(db, google, keep, item):
        """Send one changed record (already written) to Google or Keep."""
        if google is not None:
            google.queue(db, "records", item["id"], item, "save")
        elif keep is not None:
            queue_keep(db, keep.email, "records", item["id"], encode(item))

    def handoff_request(self, db, store, username):
        """One line for the next caregiver ("약 먹였어요"); an empty text clears it."""
        text = self.body(4096).get("text")
        if not isinstance(text, str) or len(text.strip()) > MAX_HANDOFF:
            raise Problem(400, f"전달 메모는 {MAX_HANDOFF}자까지 남길 수 있어요.")
        text = " ".join(text.split())
        store.put_setting(db, "handoff", {"text": text, "by": username, "at": local_now()[:16]} if text else None)
        return {"data": store.state(db), "settings": store.settings(db)}

    def timer_request(self, db, store, google, keep, username):
        """The direct-breastfeeding timer, shared by the family's phones: start, switch sides, finish or cancel.

        Finishing saves a 모유 feeding at the start time with the total minutes and the minutes per side.
        """
        body = self.body(4096)
        action, timer, now = body.get("action"), store.settings(db)["timer"], local_now()
        saved = None
        if action == "start":
            if timer:
                raise Problem(409, "이미 직수 타이머가 돌고 있어요. 화면을 새로고침해 주세요.")
            side = body.get("side") if body.get("side") in TIMER_SIDES else TIMER_SIDES[0]
            timer = {"segments": [{"side": side, "start": now}], "by": username}
            # Nursing means the baby is awake: the open sleep ends when the timer starts (cancel reopens it).
            store.snapshot(db)
            woke = end_open_sleep(db, now[:16])
            if woke:
                timer["woke"] = {"id": woke["id"], "end": woke["end"]}
                self.queue_change(db, google, keep, woke)
        elif action in ("switch", "finish", "cancel"):
            if not timer:
                raise Problem(409, "돌고 있는 직수 타이머가 없어요. 화면을 새로고침해 주세요.")
            if action == "switch":
                last = timer["segments"][-1]
                last["end"] = now
                timer["segments"].append({"side": TIMER_SIDES[1] if last["side"] == TIMER_SIDES[0] else TIMER_SIDES[0],
                                          "start": now})
            elif action == "finish":
                saved = timer_feeding(timer, now)
                self.save_item(db, store, google, keep, "records", saved)
                timer = None
            else:
                # Cancelling also undoes the wake-up the start wrote, unless someone changed that sleep since.
                woke = timer.get("woke") or {}
                row = db.execute("SELECT body FROM items WHERE kind='records' AND id=?", (woke.get("id"),)).fetchone()
                sleep = json.loads(row[0]) if row else None
                if sleep and sleep.get("end") == woke.get("end"):
                    self.save_item(db, store, google, keep, "records", {**sleep, "end": ""})
                timer = None
        else:
            raise Problem(400, "타이머 동작을 확인해 주세요.")
        store.put_setting(db, "timer", timer)
        result = {"data": store.state(db), "aliases": load_aliases(db), "settings": store.settings(db)}
        if saved:
            result["saved"] = saved
        if action == "start" and timer.get("woke"):
            result["woke"] = timer["woke"]
        return result

    def family_request(self, family, username):
        """Who is in this family: list members, pre-register an address, invite by link, remove or leave."""
        if username == GUEST:
            raise Problem(403, READ_ONLY_MESSAGE)
        server, home = self.server, self.server.store
        body = self.body(4096) if self.command == "POST" else None
        removed = None
        try:
            with home.lock, home.connect() as db:
                if body is not None:
                    db.execute("BEGIN IMMEDIATE")
                    if not server.registry.exists(db, family.id):
                        raise Problem(401, "가족 구성이 바뀌었어요. 다시 로그인해 주세요.")
                    extra, removed = server.registry.change(db, family.id, body, server.family_empty)
                else:
                    extra = {}
                gone = not server.registry.exists(db, family.id)
                anchor = getattr(server.google, "email", "") if family.home else ""
                result = {} if gone else server.registry.overview(db, family.id, username, anchor)
        except Refused as refused:
            raise Problem(refused.status, refused.message) from None
        if removed:
            server.end_sessions(family.id, removed)
        if gone:
            server.retire_family(family.id)
        else:
            bridge = family.google
            result["google"] = {"connected": bridge is not None, "email": getattr(bridge, "email", ""),
                                "calendar": bool(bridge and bridge.calendar)}
        return {**result, **extra, "signed_out": removed == username or gone}

    def handle_request(self):
        try:
            self.connection.settimeout(20)
            origin = self.headers.get("Origin")
            if origin is not None and origin not in self.server.origins:
                raise Problem(403, "허용되지 않은 사이트의 요청입니다.")
            if self.command == "OPTIONS":
                self.respond(204, b"", "text/plain")
                return
            path = urlsplit(self.path).path
            if not path.startswith("/api/"):
                name = "index.html" if path == "/" else path.removeprefix("/")
                if self.command != "GET" or name not in STATIC:
                    raise Problem(404, "페이지를 찾을 수 없습니다.")
                self.respond(200, (ROOT / name).read_bytes(), (mimetypes.guess_type(name)[0] or "text/plain") + "; charset=utf-8")
                return
            if path == "/api/health" and self.command == "GET":
                self.respond(200, {"ok": True})
                return
            store = self.server.store
            if path == "/api/google/start" and self.command == "POST":
                self.respond(200, self.google_start())
                return
            if path == google_web.CALLBACK_PATH and self.command == "GET":
                self.google_callback()
                return
            if path == "/api/login/google" and self.command == "POST":
                found = self.server.login_codes.take(self.body(4096).get("code"))
                if found is None:
                    raise Problem(401, "Google 로그인 시간이 지났어요. 다시 로그인해 주세요.")
                self.respond(200, {**found, "read_only": False})
                return
            if path == "/api/login" and self.command == "POST":
                body = self.body()
                username, password = body.get("username"), body.get("password")
                if not isinstance(username, str) or len(username) > 100 or not password_text(password):
                    raise Problem(400, "아이디와 비밀번호를 확인해 주세요.")
                with self.server.credential_attempt(401):
                    result = store.login(username, password)
                self.respond(200, result)
                return
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer ") or len(auth) > 200:
                raise Problem(401, "로그인이 필요합니다.")
            token = auth[7:]
            if path == "/api/ai" and self.command in ("GET", "POST"):
                self.respond(200, self.ai_request(token))
                return
            if path == "/api/password" and self.command == "POST":
                body = self.body()
                current, new = body.get("currentPassword"), body.get("newPassword")
                if not password_text(current):
                    raise Problem(400, "현재 비밀번호를 입력해 주세요.")
                if not valid_new_password(new):
                    raise Problem(400, f"새 비밀번호를 {MIN_PASSWORD_LENGTH}~{MAX_PASSWORD_LENGTH}자로 입력해 주세요.")
                if not self.server.family_for(token).home:
                    raise Problem(403, "Google로 로그인한 계정은 비밀번호가 없어요.")
                with store.lock, store.connect() as db:
                    if store.user(db, token) == GUEST:
                        raise Problem(403, READ_ONLY_MESSAGE)
                with self.server.credential_attempt(403):
                    store.change_password(token, current, new)
                self.respond(200, {"ok": True})
                return
            family = self.server.family_for(token)
            store, google, keep = family.store, family.google, family.keep
            if path == "/api/family" and self.command in ("GET", "POST"):
                # Taken outside the family's lock: the registry lives in the home database.
                with store.lock, store.connect() as db:
                    username = store.user(db, token)
                self.respond(200, self.family_request(family, username))
                return
            with store.lock, store.connect() as db:
                username = store.user(db, token)
                if path == "/api/me" and self.command == "GET":
                    with self.server.store.connect() as home:
                        name = self.server.registry.name(home, family.id)
                    result = {"username": username, "read_only": username == GUEST,
                              "family": {"home": family.home, "name": name}}
                elif path == "/api/logout" and self.command == "POST":
                    db.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),))
                    result = {"ok": True}
                elif username == GUEST:
                    # The guest never reads family records and never writes anything: made-up records only.
                    if path != "/api/data" or self.command != "GET":
                        raise Problem(403, READ_ONLY_MESSAGE)
                    self.respond(200, {**demo_payload(), "holidays": holiday_listing(db)})
                    return
                elif path == "/api/data" and self.command == "GET":
                    result = {"data": store.state(db), "aliases": load_aliases(db),
                              "holidays": self.server.holidays(db, family), "settings": store.settings(db)}
                    if google is not None:
                        result["sources"] = google.sources()
                        result["google_status"] = google.status(db)
                        if google.calendar is not None:
                            result["calendar_events"] = google.calendar.view_events(db)
                elif path == "/api/settings" and self.command == "PUT":
                    # Children's names, shared by every phone. A rename also moves that child's schedules.
                    body = self.body(16 * 1024)
                    children = valid_children(body.get("children"))
                    rename = body.get("rename") or {}
                    if not isinstance(rename, dict) or not all(isinstance(k, str) and v in children for k, v in rename.items()):
                        raise Problem(400, "바꿀 이름을 다시 확인해 주세요.")
                    moved = [(item_id, {**item, "who": rename[item["who"]]}) for item_id, item in
                             ((row[0], json.loads(row[1])) for row in db.execute("SELECT id,body FROM items WHERE kind='schedule'"))
                             if item.get("who") in rename]
                    if moved:
                        store.snapshot(db)
                    db.execute("INSERT INTO family_settings VALUES('children',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                               (encode(children),))
                    for item_id, item in moved:
                        db.execute("UPDATE items SET body=? WHERE kind='schedule' AND id=?", (encode(item), item_id))
                        if google is not None:
                            google.queue(db, "schedule", item_id, item, "save")
                    result = {"data": store.state(db), "settings": store.settings(db), "moved": len(moved)}
                elif path == "/api/handoff" and self.command == "POST":
                    result = self.handoff_request(db, store, username)
                elif path == "/api/timer" and self.command == "POST":
                    result = self.timer_request(db, store, google, keep, username)
                elif path == "/api/merge" and self.command == "POST":
                    # Old device records (before login existed) belong to the original family only.
                    if not family.home:
                        raise Problem(403, "이 기기의 예전 기록은 기본 가족에만 옮길 수 있어요.")
                    result = store.merge(db, self.body())
                    if google is not None:
                        result["sources"] = google.sources()
                        result["google_status"] = google.status(db)
                elif path == "/api/calendar-writeback" and self.command == "POST":
                    if google is None or google.calendar is None:
                        raise Problem(404, "Google 캘린더 연결이 없어요.")
                    item_id = self.body().get("id")
                    if not isinstance(item_id, str) or not 0 < len(item_id) <= 200:
                        raise Problem(400, "반영할 기록을 다시 선택해 주세요.")
                    try:
                        title = google.calendar.request_writeback(db, item_id)
                    except WritebackRefused as refused:
                        raise Problem(409, str(refused)) from None
                    result = {"data": store.state(db), "aliases": load_aliases(db), "sources": google.sources(),
                              "google_status": google.status(db), "title": title}
                elif path == "/api/confirm" and self.command == "POST":
                    # One tap settles the kind of a feeding saved from an unclear voice or Calendar input.
                    body = self.body()
                    forget, item_id, category = body.get("forget"), body.get("id"), body.get("category")
                    if isinstance(forget, str) and 0 < len(forget) <= 20:
                        db.execute("DELETE FROM feeding_aliases WHERE word=?", (forget,))
                    elif (isinstance(item_id, str) and 0 < len(item_id) <= 200
                            and category in (*FEEDING_KINDS, "기타", *SLEEP_KINDS)):
                        row = db.execute("SELECT body FROM items WHERE kind='records' AND id=?", (item_id,)).fetchone()
                        item = json.loads(row[0]) if row else {}
                        allowed = SLEEP_KINDS if item.get("type") == "sleep" else (*FEEDING_KINDS, "기타")
                        if item.get("confirm") == "category" and category not in allowed:
                            raise Problem(400, "이 기록에 맞는 종류를 골라 주세요.")
                        if item.get("confirm") != "category":
                            raise Problem(409, "이미 확인했거나 찾을 수 없는 기록이에요. 화면을 새로고침해 주세요.")
                        del item["confirm"]
                        item["category"] = category
                        relearn(db, item)
                        store.snapshot(db)
                        db.execute("UPDATE items SET body=? WHERE kind='records' AND id=?", (encode(item), item_id))
                        if google is not None:
                            google.queue(db, "records", item_id, item, "save")
                    else:
                        raise Problem(400, "확인할 기록과 종류를 다시 선택해 주세요.")
                    result = {"data": store.state(db), "aliases": load_aliases(db)}
                    if google is not None:
                        result["sources"] = google.sources()
                        result["google_status"] = google.status(db)
                elif path == "/api/review" and self.command == "POST":
                    if google is None:
                        raise Problem(404, "Google 음성 입력 연결이 없어요.")
                    body = self.body()
                    key, action, kind = body.get("key"), body.get("action"), body.get("kind")
                    if not isinstance(key, str) or not 0 < len(key) <= 300 or action not in ("save", "dismiss"):
                        raise Problem(400, "확인할 항목을 다시 선택해 주세요.")
                    item = None
                    if action == "save":
                        if kind not in KINDS or not isinstance(body.get("item"), dict):
                            raise Problem(400, "올바른 기록이 아닙니다.")
                        # The server assigns the ID that automatic import would have used.
                        item = validate_item(kind, {**body["item"], "id": "review"})
                    try:
                        google.resolve_review(db, key, action, kind, item)
                    except LookupError:
                        raise Problem(409, "이미 처리됐거나 찾을 수 없는 항목이에요. 화면을 새로고침해 주세요.") from None
                    result = {"data": store.state(db), "sources": google.sources(), "google_status": google.status(db)}
                elif path.startswith("/api/items/"):
                    parts = path.split("/")
                    if len(parts) != 5 or parts[3] not in KINDS or self.command not in ("PUT", "DELETE"):
                        raise Problem(404, "기록 경로를 확인해 주세요.")
                    kind, item_id = parts[3], unquote(parts[4])
                    if not item_id or len(item_id) > 200:
                        raise Problem(400, "기록 ID를 확인해 주세요.")
                    if self.command == "PUT":
                        item = validate_item(kind, self.body())
                        if item["id"] != item_id:
                            raise Problem(400, "기록 ID가 일치하지 않습니다.")
                        self.save_item(db, store, google, keep, kind, item)
                    else:
                        item = None
                        if google is not None:
                            row = db.execute("SELECT body FROM items WHERE kind=? AND id=?", (kind, item_id)).fetchone()
                            item = json.loads(row[0]) if row else None
                        store.snapshot(db)
                        db.execute("DELETE FROM items WHERE kind=? AND id=?", (kind, item_id))
                        if google is not None:
                            google.queue(db, kind, item_id, item, "delete")
                        elif keep is not None:
                            queue_keep(db, keep.email, kind, item_id, None)
                    result = {"data": store.state(db), "aliases": load_aliases(db)}
                else:
                    raise Problem(404, "API를 찾을 수 없습니다.")
            # Only acknowledge a change after the SQLite context has committed it.
            if (path in ("/api/data", "/api/merge") and google is None and family.home
                    and (store.directory / "google-records.json").exists()):
                result["google_status"] = {"auth_state": "configuration_error", "services": {}, "review": 0, "errors": []}
            sync = google or keep
            if sync is not None and (path.startswith("/api/items/") or path in ("/api/review", "/api/confirm", "/api/calendar-writeback", "/api/settings", "/api/timer")):
                sync.wake.set()
            self.respond(200, result)
        except (Problem, AIError) as error:
            self.reply_error(error.status, error.message)
        except (OSError, sqlite3.Error):
            self.reply_error(503, "맥미니 저장소에 접근하지 못했습니다. 입력을 유지하고 다시 시도해 주세요.")

    def reply_error(self, status, message):
        try:
            self.respond(status, {"error": message})
        except OSError:
            self.close_connection = True  # The browser already gave up waiting.

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = handle_request


def keep_status(directory):
    email = configured_email(directory)
    if email is None:
        print("Google Keep: 비활성 (유효한 연결 설정 없음)")
        return
    path = directory / "somhouse.sqlite3"
    if not path.is_file():
        raise SystemExit("Google Keep 설정은 있지만 솜하우스 SQLite 파일을 찾지 못했습니다.")
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keep_pending'").fetchone()
        pending = db.execute("SELECT COUNT(*) FROM keep_pending WHERE email=?", (email,)).fetchone()[0] if exists else 0
    print(f"Google Keep: 연결 설정 있음 · 이 계정의 대기 작업 {pending}건")
    print("설정은 서버 시작 시 적용됩니다. 실제 연결 확인은 keep-test를 사용하세요.")


def google_status(directory):
    config = load_google_config(directory)
    if config is None:
        print("Google Tasks·Sheets: 비활성 (유효한 연결 설정 없음)")
        return
    path = directory / "somhouse.sqlite3"
    if not path.is_file():
        raise SystemExit("Google 설정은 있지만 솜하우스 SQLite 파일을 찾지 못했습니다.")
    store = Store(directory)
    bridge = GoogleRecords(store, config)
    with store.connect() as db:
        status = bridge.status(db)
    print("Google 인증: " + ("재연결 필요" if status["auth_state"] == "reconnect_required" else "연결 설정 있음"))
    for name, state in status["services"].items():
        print(f"{name}: 미전송 {state['pending']}건 · 재시도 {state['retrying']}건 · 실패 격리 {state['failed']}건 · 마지막 성공 {state['last_success'] or '없음'}")
        if state["last_error"]:
            print(f"  마지막 오류: {state['last_error']}")
    print(f"음성 확인 필요: {status['review']}건 (Tasks + Calendar)")
    for error in status["errors"]:
        print(f"{error['target']}: {error['last_error']}")


def delete_record(directory, kind, item_id):
    """Admin removal of one record: manual backup first, then delete.

    A record that was ever sent to Google gets a delete event so the Tasks copy, Sheets history and
    Calendar projection follow. A record that never left the Mac mini leaves nothing behind externally.
    """
    if kind not in KINDS or not item_id:
        raise SystemExit("--kind (records/schedule/shopping)와 --item-id를 지정해 주세요.")
    store = Store(directory)
    config = load_google_config(directory)
    bridge = GoogleRecords(store, config) if config else None
    with store.lock, store.connect() as db:
        row = db.execute("SELECT body FROM items WHERE kind=? AND id=?", (kind, item_id)).fetchone()
        if row is None:
            raise SystemExit("해당 기록이 없습니다. 이미 삭제됐거나 ID가 다릅니다.")
        item = json.loads(row[0])
        backup = store.snapshot(db, automatic=False)
        db.execute("DELETE FROM items WHERE kind=? AND id=?", (kind, item_id))
        sent = bridge is not None and db.execute(
            """SELECT 1 FROM google_record_events WHERE item_id=? UNION ALL
               SELECT 1 FROM google_calendar_links WHERE item_id=? LIMIT 1""", (item_id, item_id)).fetchone()
        if sent:
            bridge.queue(db, kind, item_id, item, "delete")
    shown = {key: item[key] for key in ("type", "date", "category", "amount", "title", "hospital") if key in item}
    print(f"삭제했습니다: {kind} {shown}")
    print(f"삭제 전 관리자 백업: {backup}")
    print("Google 사본에도 삭제를 전송합니다. 서버 worker가 자동 처리합니다." if sent
          else "Google로 보낸 적이 없는 기록이라 외부에 남는 흔적은 없습니다.")


def list_families(directory):
    """Admin view: every family, its members and pre-registered addresses, and how many records it holds."""
    store = Store(directory)
    registry = Registry(store)
    with store.connect() as db:
        rows = registry.families(db)
        for family, name in rows:
            target = store if family == HOME else Store(store.directory / "families" / family)
            with target.connect() as fdb:
                count = fdb.execute("SELECT COUNT(*) FROM items").fetchone()[0]
            members = [row[0] for row in db.execute("SELECT email FROM family_members WHERE family=?", (family,))]
            waiting = [row[0] for row in db.execute("SELECT email FROM family_emails WHERE family=?", (family,))]
            print(f"{name} [{family}] 기록 {count}건")
            print("  구성원: " + (", ".join(([] if family != HOME else ["연결된 가족 Google 계정"]) + members) or "없음"))
            if waiting:
                print("  미리 등록한 주소: " + ", ".join(waiting))
    print(f"가족 {len(rows)}개 (새 가족은 최대 {families.MAX_FAMILIES}개)")


def ai_status(directory):
    """Which AI CLIs the AI page offers. Read-only."""
    for provider in Assistants.load(directory).providers.values():
        if provider.binary:
            summaries = "기록 집계 전송 허용" if provider.allow_summaries else "질문만 전송"
            print(f"{provider.name} ({provider.company}): 연결됨 · {provider.binary} · 모델 {provider.model or 'CLI 기본값'} · {summaries}")
        else:
            print(f"{provider.name} ({provider.company}): 연결 안 됨 — python3 server.py ai-config --provider {provider.id}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "serve", "password", "backup", "restore",
                        "ai-status", "ai-config", "ai-test", "ai-disconnect",
                        "antigravity-config", "antigravity-test", "keep-config", "keep-test", "keep-status",
                        "google-status", "google-retry", "google-backfill", "delete-record", "guest", "google-web-client", "families"),
                        nargs="?", default="serve")
    parser.add_argument("--kind", choices=KINDS, help="delete-record: 기록 종류")
    parser.add_argument("--item-id", help="delete-record: 삭제할 기록 ID")
    parser.add_argument("username", nargs="?")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--allow-record-summaries", action="store_true", help="ai-config: 질문에 가족 기록 집계를 함께 보낼 수 있게 함")
    parser.add_argument("--provider", choices=tuple(assistants.PROVIDERS), help="ai-config/ai-test/ai-disconnect: 연결할 AI")
    parser.add_argument("--bin", type=Path, help="ai-config/ai-test: AI CLI 실행 파일 경로 (기본: 설치된 위치)")
    parser.add_argument("--model", help="ai-config/ai-test: 사용할 모델 (기본: CLI 기본값)")
    parser.add_argument("--agy", type=Path, help="antigravity-config/antigravity-test: Antigravity CLI 경로 (--bin과 같음)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--origin", action="append", default=[])
    parser.add_argument("--file", type=Path, help="관리자 복원용 JSON 파일 / google-web-client: 웹 OAuth JSON")
    parser.add_argument("--public-url", default="https://ssoomm-main.tail31d445.ts.net", help="google-web-client: 서버 공개 HTTPS 주소")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "keep-status":
        keep_status(args.data_dir)
        return
    if args.command == "google-status":
        google_status(args.data_dir)
        return
    if args.command == "ai-status":
        ai_status(args.data_dir)
        return
    if args.command == "google-web-client":
        if not args.file:
            parser.error("Google Cloud에서 받은 웹 애플리케이션 OAuth JSON을 --file 로 지정해 주세요.")
        try:
            redirect = google_web.save_web_client(args.data_dir, args.file, args.public_url)
        except (OSError, ValueError) as error:
            parser.exit(1, f"{error}\n")
        print(f"Google 웹 로그인 설정을 저장했습니다. 리디렉션 URI: {redirect}\n서버를 다시 시작할 필요는 없습니다.")
        return
    if args.command == "delete-record":
        delete_record(args.data_dir, args.kind, args.item_id)
        return
    if args.command == "families":
        list_families(args.data_dir)
        return
    if args.command in ("google-retry", "google-backfill"):
        store = Store(args.data_dir)
        bridge = GoogleRecords.load(store)
        if bridge is None:
            parser.error("먼저 Google 계정을 연결해 주세요.")
        with store.lock, store.connect() as db:
            if args.command == "google-retry":
                count = db.execute("DELETE FROM google_delivery_retries WHERE binding=?", (bridge.binding,)).rowcount
                db.execute("UPDATE google_service_state SET attempts=0,next_retry_at=0 WHERE binding=?", (bridge.binding,))
                print(f"전송 {count}건을 재시도 대기열로 돌렸습니다. 재연결 필요 상태는 계정을 다시 연결해야 해제됩니다.")
            else:
                count = bridge.backfill(db)
                print(f"기존 기록 {count}건을 전송 대기열에 추가했습니다. 서버 worker가 자동 전송합니다.")
        return
    store = Store(args.data_dir)
    if args.command in ("keep-config", "keep-test"):
        try:
            keep = KeepSync(store, args.username)
        except ValueError:
            parser.error("Google Keep 계정 이메일을 지정해 주세요.")
        try:
            if args.command == "keep-config":
                keep.configure()
                print(f"{KEEP_CONFIG_NAME}에 저장했습니다. 솜하우스 서버를 다시 시작해 주세요.")
            else:
                keep.probe()
                print("Google Keep에서 분유 120ml 시험 메모를 다시 읽고 휴지통으로 보냈습니다.")
        except (OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
            parser.exit(1, "Google Keep 연결을 확인하지 못했습니다. 전용 Python 환경과 키체인 항목을 확인해 주세요.\n")
    elif args.command in ("ai-config", "ai-test", "ai-disconnect", "antigravity-config", "antigravity-test"):
        name = "antigravity" if args.command.startswith("antigravity-") else args.provider
        if name is None:
            parser.error("--provider 로 " + "/".join(assistants.PROVIDERS) + " 중 하나를 지정해 주세요.")
        kind = assistants.PROVIDERS[name]
        if args.command == "ai-disconnect":
            found = assistants.remove_config(store.directory, name)
            print(f"{kind.name} 연결을 해제했습니다. 솜하우스 서버를 다시 시작해 주세요." if found else f"{kind.name}는 연결되어 있지 않습니다.")
            return
        if args.model is not None and not assistants.MODEL_NAME.fullmatch(args.model):
            parser.error("--model 이름을 확인해 주세요.")
        path = args.bin or args.agy or kind.default_binary
        # Keep the link (e.g. ~/.local/bin/codex) so a CLI update that moves the real file keeps working.
        binary = assistants.executable(str(path.expanduser().absolute()))
        if binary is None:
            parser.error(f"--bin 으로 실행 가능한 {kind.name} CLI 경로를 지정해 주세요. (확인한 위치: {path})")
        provider = kind(store.directory, binary, model=args.model)
        try:
            result = provider.generate("한국어로 솜하우스 연결 확인이라고 한 줄로 답해 주세요.", "none", None)
        except AIError as error:
            parser.exit(1, f"{error.message}\n")
        if args.command.endswith("-config"):
            assistants.save_config(store.directory, name, binary, args.allow_record_summaries, args.model)
            print(f"{kind.name} 응답 확인: {result['answer']}")
            print(f"{assistants.CONFIG_NAME}에 저장했습니다. 솜하우스 서버를 다시 시작해 주세요.")
        else:
            print(result["answer"])
    elif args.command == "init":
        with store.connect() as db:
            if db.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
                parser.exit(message="계정이 이미 있습니다. 기존 계정과 기록을 유지합니다.\n")
        accounts = [(name, secrets.token_urlsafe(18)) for name in ("family1", "family2")]
        path = store.directory / "initial-accounts.txt"
        with path.open("x", encoding="utf-8") as file:
            file.write("솜하우스 가족 로그인 정보 — 공개하거나 Git에 올리지 마세요.\n\n")
            for name, password in accounts:
                store.password(name, password)
                file.write(f"아이디: {name}\n비밀번호: {password}\n\n")
        print(f"가족 계정 두 개를 생성했습니다. 로그인 정보: {path}")
    elif args.command == "backup":
        with store.lock, store.connect() as db:
            path = store.snapshot(db, automatic=False)
        print(f"관리자 백업 완료: {path}")
    elif args.command == "restore":
        if not args.file:
            parser.error("복원할 백업을 --file 로 지정해 주세요.")
        try:
            original = validate_data(json.loads(args.file.read_text(encoding="utf-8")))
            with store.lock, store.connect() as db:
                result = store.merge(db, original, restore=True)
        except (OSError, ValueError, Problem) as error:
            parser.exit(1, f"복원하지 못했습니다. 기존 기록은 유지됩니다: {error}\n")
        print(f"관리자 복원 완료: {result['added']}개 추가, {result['skipped']}개 중복 건너뜀. 기존 기록 유지.")
    elif args.command == "guest":
        # Read-only demo account. Running it again issues a new password and signs the guest out everywhere.
        password = secrets.token_urlsafe(12)
        store.password(GUEST, password)
        print(f"게스트(읽기 전용, 예시 기록만 표시)\n아이디: {GUEST}\n비밀번호: {password}")
    elif args.command == "password":
        with store.connect() as db:
            if not db.execute("SELECT 1 FROM users WHERE username=?", (args.username,)).fetchone():
                parser.error("기존 계정 아이디를 지정해 주세요.")
        password = getpass.getpass(f"새 비밀번호 ({MIN_PASSWORD_LENGTH}자 이상): ")
        if not valid_new_password(password) or password != getpass.getpass("다시 입력: "):
            parser.error(f"{MIN_PASSWORD_LENGTH}~{MAX_PASSWORD_LENGTH}자의 일치하는 비밀번호를 입력해 주세요.")
        store.password(args.username, password)
        print("비밀번호를 변경하고 해당 계정의 기존 로그인을 해제했습니다.")
    else:
        with store.connect() as db:
            if db.execute("SELECT COUNT(*) FROM users WHERE username<>?", (GUEST,)).fetchone()[0] != 2:
                parser.error("먼저 python3 server.py init 명령으로 두 계정을 생성해 주세요.")
        server = FamilyServer(("127.0.0.1", args.port), store, args.origin, holidays=True)
        print(f"솜하우스: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
