"""Copy new web saves to an explicitly connected Google Keep account."""
import fcntl
import getpass
import hmac
import json
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import uuid
import warnings


CONFIG_NAME = "keep-config.json"
KEYCHAIN_SERVICE = "com.ssoomm.somhouse.keep"
SCHEMA = """
CREATE TABLE IF NOT EXISTS keep_pending (
    email TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL,
    body TEXT, PRIMARY KEY(email, kind, id)
);
CREATE TABLE IF NOT EXISTS keep_notes (
    email TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, marker TEXT NOT NULL,
    note_ids TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(email, kind, id)
);
"""
FIELDS = {
    "date": "날짜와 시간", "category": "수유 종류", "amount": "양 또는 시간",
    "hospital": "병원", "reason": "방문 이유", "title": "이름", "quantity": "수량",
    "done": "구매 상태", "url": "상품 링크", "memo": "메모",
}
TITLES = {"feeding": "수유 기록", "hospital": "병원 방문", "schedule": "일정", "shopping": "구매 목록"}
RECORD_FIELDS = {
    "feeding": ("date", "category", "amount", "memo"),
    "hospital": ("date", "hospital", "reason", "memo"),
    "schedule": ("date", "title", "memo"),
    "shopping": ("title", "quantity", "done", "url", "memo"),
}
PROBE = {"type": "feeding", "category": "분유", "amount": "120ml", "memo": "연결 확인용 가짜 기록"}
MARKER = re.compile(r"솜하우스 복사 ([0-9a-f]{32})/([1-9][0-9]?)")


def account_email(email):
    if not isinstance(email, str) or not re.fullmatch(r"[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+", email):
        raise ValueError("Invalid account email")
    return email.lower()


def queue(db, email, kind, item_id, body):
    if body is not None:
        db.execute("""
            INSERT OR IGNORE INTO keep_notes (email, kind, id, marker) VALUES (?, ?, ?, ?)
        """, (email, kind, item_id, secrets.token_hex(16)))
    db.execute("""
        INSERT INTO keep_pending VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email, kind, id) DO UPDATE SET revision=excluded.revision, body=excluded.body
    """, (email, kind, item_id, secrets.token_hex(16), body))


def note_content(kind, item):
    record_type = item["type"] if kind == "records" else kind
    title = f"솜하우스 · {TITLES[record_type]}"
    lines = []
    for key in RECORD_FIELDS[record_type]:
        value = item.get(key, "no" if key == "done" else "")
        if key == "done":
            value = "완료" if value == "yes" else "미완료"
        if value:
            lines.append(f"{FIELDS[key]}: {value}")
    return title, "\n".join(lines)


def note_parts(kind, item):
    if item is None:
        return {}
    title, body = note_content(kind, item)
    # Budget for UTF-16 as well as Python code points, without splitting an emoji.
    parts, start, units = [], 0, 0
    for index, char in enumerate(body):
        width = 2 if ord(char) > 0xffff else 1
        if units + width > 8000:
            parts.append(body[start:index])
            start, units = index, 0
        units += width
    parts.append(body[start:])
    return {
        str(index): (title if len(parts) == 1 else f"{title} ({index}/{len(parts)})", part)
        for index, part in enumerate(parts, 1)
    }


def recovery_marker(secret, prior_id=""):
    # A replacement after permanent deletion gets a different marker from the
    # original, so even an exact manual copy of the original isn't selected.
    return hmac.digest(bytes.fromhex(secret), prior_id.encode(), "sha256").hex()[:32]


def with_marker(content, marker, index):
    return f"{content}\n\n솜하우스 복사 {marker}/{index}"


def mirror(client, entries):
    from gkeepapi.node import Note

    # Look up persisted note IDs first. A marker recovers a new note if a prior
    # upload reached Keep but its IDs could not be committed locally.
    markers = {
        recovery_marker(entry["marker"], prior_id): {}
        for entry in entries for prior_id in ("", *entry["note_ids"].values())
    }
    for note in client.all():
        if isinstance(note, Note) and not note.deleted:
            match = MARKER.fullmatch(note.text.rsplit("\n", 1)[-1])
            if match and match[1] in markers:
                markers[match[1]].setdefault(match[2], []).append(note)
    results = []
    for entry in entries:
        secret, known = entry["marker"], entry["note_ids"]
        parts = note_parts(entry["kind"], entry["item"])
        found = markers[recovery_marker(secret)]
        ids = dict(known)
        for index in dict.fromkeys((*parts, *known, *found)):
            prior_id = known.get(index, "")
            note = client.get(prior_id) if prior_id else None
            identified = isinstance(note, Note) and not note.deleted
            marker = recovery_marker(secret, prior_id)
            if not identified:
                candidates = markers[marker].get(index, ())
                note = candidates[0] if len(candidates) == 1 else None
            if index in parts:
                title, content = parts[index]
                if not identified:
                    content = with_marker(content, marker, index)
                if note is None:
                    note = client.createNote(title, content)
                else:
                    if note.trashed:
                        note.untrash()
                    if (note.title, note.text) != (title, content):
                        note.title, note.text = title, content
            elif note is not None and not note.trashed:
                note.trash()
            if note is not None:
                ids[index] = note.id
        results.append(ids)
    client.sync()
    return results


def read_credential(email):
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", email, "-w"],
        capture_output=True, text=True, check=True, timeout=10,
    )
    credential = result.stdout.strip()
    if not credential:
        raise RuntimeError("Empty Keychain credential")
    return credential


def client_run(email, entries, verify=False):
    import gkeepapi

    client = gkeepapi.Keep()
    client.authenticate(email, read_credential(email))
    results = mirror(client, entries)
    if verify:
        entry = entries[0]
        title, content = note_parts(entry["kind"], entry["item"])["1"]
        expected = title, with_marker(content, recovery_marker(entry["marker"]), "1")
        client.sync(resync=True)
        note = client.get(results[0]["1"])
        if note is None or note.deleted or note.trashed or (note.title, note.text) != expected:
            raise RuntimeError("Keep did not return the test note")
        note.trash()
        client.sync()
    return results


def register_credential(email, oauth_token):
    import gpsoauth

    email = account_email(email)
    oauth_token = oauth_token.strip()
    if not oauth_token:
        raise ValueError("Missing OAuth token")
    response = gpsoauth.exchange_token(email, oauth_token, f"{uuid.getnode():x}")
    credential = response.get("Token", "")
    account = response.get("Email", email)
    if account.casefold() != email.casefold() or not re.fullmatch(r"[A-Za-z0-9_./+=-]{1,3000}", credential):
        raise ValueError("Token exchange did not return a credential for the selected account")
    # Pass the secret to security through stdin so it cannot appear in process arguments.
    command = f'add-generic-password -U -s {KEYCHAIN_SERVICE} -a "{email}" -w "{credential}"\n'
    subprocess.run(["/usr/bin/security", "-i"], input=command, text=True, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    if not hmac.compare_digest(read_credential(email), credential):
        raise RuntimeError("Keychain did not store the new credential")


def configured_email(directory):
    path = directory / CONFIG_NAME
    try:
        if not path.stat().st_mode & 0o077:
            return account_email(json.loads(path.read_text(encoding="utf-8"))["email"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


class KeepSync:
    def __init__(self, store, email):
        self.store = store
        self.email = account_email(email)
        self.wake = threading.Event()
        self.stop = threading.Event()

    @classmethod
    def load(cls, store):
        email = configured_email(store.directory)
        return cls(store, email) if email is not None else None

    def send(self, entries, verify=False):
        python = self.store.directory / "keep-venv/bin/python"
        request = json.dumps({"email": self.email, "entries": entries, "verify": verify})
        result = subprocess.run(
            [python, "-I", Path(__file__).resolve()], input=request, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60,
        )
        if result.returncode:
            raise RuntimeError("Keep sync failed")
        try:
            ids = json.loads(result.stdout)
            if not isinstance(ids, list) or len(ids) != len(entries) or not all(
                isinstance(parts, dict) and all(isinstance(note_id, str) and note_id
                                                for note_id in parts.values())
                for parts in ids
            ):
                raise ValueError
        except ValueError:
            raise RuntimeError("Invalid Keep sync result") from None
        return ids

    def probe(self):
        self.send([{"kind": "records", "item": PROBE, "marker": secrets.token_hex(16),
                    "note_ids": {}}], verify=True)

    def configure(self):
        self.probe()
        fd, path = tempfile.mkstemp(dir=self.store.directory)
        try:
            with open(fd, "w", encoding="utf-8") as file:
                json.dump({"email": self.email}, file)
            Path(path).replace(self.store.directory / CONFIG_NAME)
        finally:
            Path(path).unlink(missing_ok=True)

    def flush(self):
        with (self.store.directory / "keep-sync.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.store.lock, self.store.connect() as db:
                rows = db.execute("""
                    SELECT p.kind, p.id, p.revision, p.body, i.body, n.marker, n.note_ids
                    FROM keep_pending AS p
                    LEFT JOIN items AS i ON i.kind=p.kind AND i.id=p.id
                    LEFT JOIN keep_notes AS n ON n.email=p.email AND n.kind=p.kind AND n.id=p.id
                    WHERE p.email=? ORDER BY p.rowid LIMIT 10
                """, (self.email,)).fetchall()
                ready = []
                for kind, item_id, revision, body, current, marker, ids in rows:
                    # Changes made while this account was disconnected don't go to Keep.
                    if body != current or (body is None and marker is None):
                        self.acknowledge(db, kind, item_id, revision)
                        continue
                    if marker is None:
                        # Preserve a pending web save created by the initial prototype.
                        marker, ids = secrets.token_hex(16), "{}"
                        db.execute("INSERT INTO keep_notes VALUES (?, ?, ?, ?, ?)",
                                   (self.email, kind, item_id, marker, ids))
                    entry = {"kind": kind, "item": json.loads(body) if body is not None else None,
                             "marker": marker, "note_ids": json.loads(ids)}
                    ready.append((kind, item_id, revision, entry))
            if not ready:
                return bool(rows)
            results = self.send([entry for _, _, _, entry in ready])
            with self.store.lock, self.store.connect() as db:
                for (kind, item_id, revision, _), ids in zip(ready, results, strict=True):
                    # IDs belong to the record even if a newer web save replaced its pending revision.
                    db.execute("UPDATE keep_notes SET note_ids=? WHERE email=? AND kind=? AND id=?",
                               (json.dumps(ids), self.email, kind, item_id))
                    self.acknowledge(db, kind, item_id, revision)
            return True

    def acknowledge(self, db, kind, item_id, revision):
        db.execute("DELETE FROM keep_pending WHERE email=? AND kind=? AND id=? AND revision=?",
                   (self.email, kind, item_id, revision))

    def run(self):
        while not self.stop.is_set():
            self.wake.clear()
            try:
                if self.flush():
                    continue
            except BlockingIOError:
                pass
            except (OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
                print("Google Keep 동기화 실패. 대기 중인 기록을 다시 시도합니다.", file=sys.stderr, flush=True)
                self.stop.wait(60)
                continue
            self.wake.wait(30)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "register":
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                oauth_token = getpass.getpass("Google 로그인 화면의 oauth_token 값을 붙여넣으세요: ")
            register_credential(sys.argv[2], oauth_token)
        except (Exception, KeyboardInterrupt):
            sys.exit("인증 정보를 등록하지 못했습니다. Google 로그인 화면과 맥 키체인을 확인해 주세요.")
        print("Google Keep 인증 정보를 맥 키체인에 저장했습니다.")
    else:
        json.dump(client_run(**json.load(sys.stdin)), sys.stdout)
