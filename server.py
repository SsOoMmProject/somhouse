"""Somhouse's small, local-only family API. Python standard library only."""
import argparse
import getpass
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = Path.home() / "Library/Application Support/Somhouse"
KINDS = ("records", "schedule", "shopping")
STATIC = {"index.html", "app.js", "service.js", "shared.js", "config.js", "style.css"}
ITERATIONS = 600_000
MAX_BODY = 4 * 1024 * 1024


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
        if item.get("type") not in ("feeding", "hospital"):
            raise Problem(400, "지원하지 않는 기록 종류입니다.")
        required += ["category", "amount"] if item["type"] == "feeding" else ["hospital", "reason"]
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
            """)
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def state(self, db):
        data = {k: [] for k in KINDS}
        for kind, body in db.execute("SELECT kind,body FROM items ORDER BY rowid"):
            data[kind].append(json.loads(body))
        return data

    def snapshot(self, db):
        folder = self.directory / "backups"
        folder.mkdir(exist_ok=True, mode=0o700)
        path = folder / (time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(6) + ".json")
        with path.open("x", encoding="utf-8") as file:
            path.chmod(0o600)
            file.write(encode(self.state(db)))
            file.flush()
            os.fsync(file.fileno())

    def password(self, username, password):
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
        with self.lock, self.connect() as db:
            db.execute("INSERT INTO users VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt,password=excluded.password", (username, salt, digest))
            db.execute("DELETE FROM sessions WHERE username=?", (username,))

    def login(self, username, password):
        with self.connect() as db:
            row = db.execute("SELECT salt,password FROM users WHERE username=?", (username,)).fetchone()
            salt, expected = row or ("00" * 16, "00" * 32)
            digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
            if not row or not hmac.compare_digest(expected, digest):
                raise Problem(401, "아이디 또는 비밀번호를 확인해 주세요.")
            token = secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), username, time.time() + 30 * 86400))
            return {"token": token, "username": username}

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


class FamilyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, origins=()):
        super().__init__(address, Handler)
        self.store = store
        port = self.server_port
        self.origins = set(origins) | {"https://ssoommproject.github.io", f"http://127.0.0.1:{port}",
                                       f"http://localhost:{port}", "http://127.0.0.1:8765", "http://localhost:8765"}
        self.failures = []
        self.login_lock = threading.Lock()


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
        if status == 429:
            self.send_header("Retry-After", "60")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise Problem(400, "지원하지 않는 요청 형식입니다.")
        if self.headers.get_content_type() != "application/json":
            raise Problem(415, "JSON 형식으로 요청해 주세요.")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > MAX_BODY:
                raise Problem(413, "요청 크기는 4MB 이하여야 합니다.")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, UnicodeError):
            raise Problem(400, "올바른 JSON 요청이 아닙니다.")

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
            if path == "/api/login" and self.command == "POST":
                body = self.body()
                username, password = body.get("username"), body.get("password")
                if not isinstance(username, str) or not isinstance(password, str) or len(username) > 100 or len(password) > 256:
                    raise Problem(400, "아이디와 비밀번호를 확인해 주세요.")
                # A global bound also works behind Funnel, whose requests share loopback IPs.
                with self.server.login_lock:
                    self.server.failures = [t for t in self.server.failures if t > time.time() - 60]
                    if len(self.server.failures) >= 10:
                        raise Problem(429, "로그인 시도가 많습니다. 1분 후 다시 시도해 주세요.")
                    try:
                        result = store.login(username, password)
                    except Problem:
                        self.server.failures.append(time.time())
                        raise
                self.respond(200, result)
                return
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer ") or len(auth) > 200:
                raise Problem(401, "로그인이 필요합니다.")
            token = auth[7:]
            with store.lock, store.connect() as db:
                username = store.user(db, token)
                if path == "/api/me" and self.command == "GET":
                    result = {"username": username}
                elif path == "/api/logout" and self.command == "POST":
                    db.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),))
                    result = {"ok": True}
                elif path == "/api/data" and self.command == "GET":
                    result = {"data": store.state(db)}
                elif path in ("/api/merge", "/api/restore") and self.command == "POST":
                    result = store.merge(db, self.body(), restore=path == "/api/restore")
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
                        store.snapshot(db)
                        db.execute("INSERT INTO items VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", (kind, item_id, encode(item)))
                    else:
                        store.snapshot(db)
                        db.execute("DELETE FROM items WHERE kind=? AND id=?", (kind, item_id))
                    result = {"data": store.state(db)}
                else:
                    raise Problem(404, "API를 찾을 수 없습니다.")
            # Only acknowledge a change after the SQLite context has committed it.
            self.respond(200, result)
        except Problem as error:
            self.respond(error.status, {"error": error.message})
        except (OSError, sqlite3.Error):
            self.respond(503, {"error": "맥미니 저장소에 접근하지 못했습니다. 입력을 유지하고 다시 시도해 주세요."})

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "serve", "password"), nargs="?", default="serve")
    parser.add_argument("username", nargs="?")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--origin", action="append", default=[])
    args = parser.parse_args()
    os.umask(0o077)
    store = Store(args.data_dir)
    if args.command == "init":
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
    elif args.command == "password":
        with store.connect() as db:
            if not db.execute("SELECT 1 FROM users WHERE username=?", (args.username,)).fetchone():
                parser.error("기존 계정 아이디를 지정해 주세요.")
        password = getpass.getpass("새 비밀번호 (12자 이상): ")
        if len(password) < 12 or len(password) > 256 or password != getpass.getpass("다시 입력: "):
            parser.error("12~256자의 일치하는 비밀번호를 입력해 주세요.")
        store.password(args.username, password)
        print("비밀번호를 변경하고 해당 계정의 기존 로그인을 해제했습니다.")
    else:
        with store.connect() as db:
            if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] != 2:
                parser.error("먼저 python3 server.py init 명령으로 두 계정을 생성해 주세요.")
        server = FamilyServer(("127.0.0.1", args.port), store, args.origin)
        print(f"솜하우스: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
