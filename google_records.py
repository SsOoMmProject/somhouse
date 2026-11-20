"""Deliver the local record journal and import tagged Google Tasks."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from google_delivery import eligible, failure, success


CONFIG_NAME = "google-records.json"
SCOPES = ("openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/tasks",
          "https://www.googleapis.com/auth/drive.file")
TASKS = "https://tasks.googleapis.com/tasks/v1/"
SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
TASKS_WEB = "https://tasks.google.com/"
TAB = "원본 기록"
HEADERS = ["이벤트 ID", "수집 시각 (서울)", "출처", "동작", "유형", "기록 ID",
           "음성 Task ID", "처리 상태", "원본 제목", "원본 데이터 (JSON)"]
SEOUL = ZoneInfo("Asia/Seoul")
PREFIX = re.compile(r"^솜\s*하우스(?=$|[\s:：,])\s*[:：,]?\s*")
VOLUME_UNIT = r"(?:ml|밀리\s*리터|미리|cc|씨씨)"
SPOKEN_TIME = re.compile(r"(?:(오전|오후)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?")
SCHEMA = """
CREATE TABLE IF NOT EXISTS google_record_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, binding TEXT NOT NULL,
    sheet_row INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
    captured TEXT NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL,
    kind TEXT NOT NULL, item_id TEXT NOT NULL, voice_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, title TEXT NOT NULL, raw TEXT NOT NULL,
    task_done INTEGER NOT NULL DEFAULT 0, sheet_done INTEGER NOT NULL DEFAULT 0,
    UNIQUE (binding, sheet_row)
);
CREATE INDEX IF NOT EXISTS google_record_deliveries
    ON google_record_events (binding, task_done, sheet_done, seq);
CREATE INDEX IF NOT EXISTS google_record_origin
    ON google_record_events (binding, source, item_id);
CREATE TABLE IF NOT EXISTS google_voice_receipts (
    binding TEXT NOT NULL, voice_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, accepted INTEGER NOT NULL,
    PRIMARY KEY (binding, voice_id)
);
CREATE TABLE IF NOT EXISTS google_task_links (
    binding TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, task_id TEXT NOT NULL,
    PRIMARY KEY (binding, kind, item_id)
);
CREATE TABLE IF NOT EXISTS google_inbox_checkpoint (
    binding TEXT NOT NULL, inbox TEXT NOT NULL, updated_min TEXT NOT NULL,
    PRIMARY KEY (binding, inbox)
);
"""


class GoogleError(RuntimeError):
    def __init__(self, status, service):
        super().__init__(f"{service} {status}")
        self.status = status


class GoogleAuthError(GoogleError):
    def __init__(self):
        super().__init__("재연결 필요", "OAuth")


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def now_seoul():
    return datetime.now(SEOUL)


def save_config(directory, config, *, filename=CONFIG_NAME):
    fd, name = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(config, file)
            file.flush()
            os.fsync(file.fileno())
        Path(name).replace(directory / filename)
    finally:
        Path(name).unlink(missing_ok=True)


def read_config(directory):
    path = directory / CONFIG_NAME
    try:
        if path.stat().st_mode & 0o077:
            print("Google 기록 연동 비활성: google-records.json 권한을 0600으로 설정해 주세요.",
                  file=sys.stderr, flush=True)
            return None
        config = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(config, dict):
            return config
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, KeyError):
        print("Google 기록 연동 비활성: 연결 설정을 읽을 수 없습니다.", file=sys.stderr, flush=True)
    return None


def load_config(directory):
    config = read_config(directory) or {}
    required = ("binding", "client_id", "client_secret", "refresh_token",
                "subject", "inbox", "task_list", "spreadsheet")
    if (config.get("ready") is True
            and all(isinstance(config.get(key), str) and config[key] for key in required)
            and re.fullmatch(r"[A-Za-z0-9_-]+", config["spreadsheet"])
            and config["inbox"] != config["task_list"]):
        return config
    return None


def json_request(url, method, data=None, headers=None, service="Google"):
    try:
        with urlopen(Request(url, data=data, headers=headers or {}, method=method), timeout=12) as response:
            body = response.read()
            result = json.loads(body) if body else {}
            if not isinstance(result, dict):
                raise ValueError("Unexpected Google response")
            return result
    except HTTPError as error:
        code = error.code
        try:
            payload = json.loads(error.read(8192)) if service == "OAuth" else {}
        except (OSError, ValueError):
            payload = {}
        finally:
            error.close()
        if isinstance(payload, dict) and payload.get("error") == "invalid_grant":
            raise GoogleAuthError() from None
        raise GoogleError(code, service) from None
    except (OSError, URLError, ValueError):
        raise GoogleError("연결 오류", service) from None


class GoogleAPI:
    def __init__(self, config, access_token=None):
        self.config = config
        self.token = access_token
        self.expires = time.monotonic() + 3500 if access_token else 0
        self.sheet_size = None
        self.sheet_id = config.get("source_sheet_id")
        self.sheet_title = TAB

    def refresh(self):
        fields = {key: self.config[key] for key in ("client_id", "client_secret", "refresh_token")}
        fields["grant_type"] = "refresh_token"
        result = json_request("https://oauth2.googleapis.com/token", "POST", urlencode(fields).encode(),
                              {"Content-Type": "application/x-www-form-urlencoded"}, "OAuth")
        if not result.get("access_token"):
            raise GoogleError("토큰 없음", "OAuth")
        self.token = result["access_token"]
        self.expires = time.monotonic() + max(0, int(result.get("expires_in", 3600)) - 60)

    def request(self, url, method="GET", body=None, service="Google", *, etag=None):
        if not self.token or time.monotonic() >= self.expires:
            self.refresh()
        for attempt in range(2):
            try:
                headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
                if etag:
                    headers["If-Match"] = etag
                return json_request(url, method, None if body is None else encode(body).encode(), headers, service)
            except GoogleError as error:
                if error.status != 401 or attempt:
                    raise
                self.refresh()

    def pages(self, url, **params):
        while True:
            response = self.request(url + "?" + urlencode(params), service="Tasks")
            yield from response.get("items", [])
            if not response.get("nextPageToken"):
                return
            params["pageToken"] = response["nextPageToken"]

    def tasks_url(self, task_list):
        return TASKS + "lists/" + quote(task_list, safe="") + "/tasks"

    def tasks(self, task_list, updated_min=None):
        params = {"updatedMin": updated_min} if updated_min else {}
        return self.pages(self.tasks_url(task_list), maxResults=100, showCompleted="true", showHidden="true", **params)

    def get_task(self, task_list, task_id):
        return self.request(self.tasks_url(task_list) + "/" + quote(task_id, safe=""), service="Tasks")

    def put_task(self, task_list, task, task_id=None, *, etag=None):
        url = self.tasks_url(task_list)
        if task_id is not None:
            return self.request(url + "/" + quote(task_id, safe=""), "PATCH", task, "Tasks", etag=etag)
        return self.request(url, "POST", task, "Tasks")

    def sheet_metadata(self):
        url = f"{SHEETS}/{self.config['spreadsheet']}"
        return self.request(url + "?fields=sheets(properties,protectedRanges)", service="Sheets")

    def source_tab(self):
        tabs = self.sheet_metadata()["sheets"]
        tab = next((tab for tab in tabs if (tab["properties"]["sheetId"] == self.sheet_id
                   if self.sheet_id is not None else tab["properties"]["title"] == TAB)), None)
        if tab is None:
            raise GoogleError("원본 탭 없음", "Sheets")
        properties = tab["properties"]
        self.sheet_id, self.sheet_title = properties["sheetId"], properties["title"]
        grid = properties["gridProperties"]
        self.sheet_size = self.sheet_id, grid["rowCount"], grid["columnCount"]
        return tab

    def protect_source(self):
        tab = self.source_tab()
        if any(p.get("description") == "솜하우스 원본 기록" and p.get("warningOnly")
               and p.get("range") == {"sheetId": self.sheet_id}
               for p in tab.get("protectedRanges", [])):
            return
        self.request(f"{SHEETS}/{self.config['spreadsheet']}:batchUpdate", "POST", {"requests": [
            {"addProtectedRange": {"protectedRange": {"range": {"sheetId": self.sheet_id},
             "description": "솜하우스 원본 기록", "warningOnly": True}}}]}, "Sheets")

    def sheet_range(self, cell):
        return quote("'" + self.sheet_title.replace("'", "''") + "'!" + cell, safe="")

    def sheet_cell(self, cell):
        if self.sheet_size is None:
            self.source_tab()
        path = self.sheet_range(cell)
        url = f"{SHEETS}/{self.config['spreadsheet']}/values/{path}"
        try:
            return self.request(url, service="Sheets").get("values", [])
        except GoogleError:
            self.sheet_size = None
            raise

    def sheet_row(self, row, values):
        try:
            self.write_sheet_row(row, values)
        except GoogleError:
            self.sheet_size = None
            raise

    def write_sheet_row(self, row, values):
        url = f"{SHEETS}/{self.config['spreadsheet']}"
        if self.sheet_size is None:
            self.source_tab()
        sheet_id, row_count, col_count = self.sheet_size
        if row > row_count or len(values) > col_count:
            new_rows, new_cols = max(row_count, row + 99), max(col_count, len(values))
            self.request(url + ":batchUpdate", "POST", {"requests": [{"updateSheetProperties": {
                "properties": {"sheetId": sheet_id, "gridProperties": {"rowCount": new_rows, "columnCount": new_cols}},
                "fields": "gridProperties(rowCount,columnCount)"}}]}, "Sheets")
            self.sheet_size = sheet_id, new_rows, new_cols
        old = self.sheet_cell(f"A{row}")
        if old and old[0][0] != values[0]:
            raise GoogleError("원본 행 충돌", "Sheets")
        cell = self.sheet_range(f"A{row}")
        self.request(f"{url}/values/{cell}?valueInputOption=RAW",
                     "PUT", {"values": [values]}, "Sheets")


def queue_event(db, binding, kind, item_id, raw, *, source="web", action="save",
                voice_id="", title="", status="저장", skip_task=False):
    skip_task = skip_task or source == "tasks" or bool(voice_id)
    if not skip_task:
        # Tasks is a current-state projection. Keep history in Sheets, but never
        # replay a failed old edit over a more recent edit or deletion.
        db.execute("""DELETE FROM google_delivery_retries WHERE binding=? AND target='tasks'
            AND job_id IN (SELECT CAST(seq AS TEXT) FROM google_record_events
                          WHERE binding=? AND kind=? AND item_id=? AND task_done=0)""",
                   (binding, binding, kind, item_id))
        db.execute("UPDATE google_record_events SET task_done=1 WHERE binding=? AND kind=? AND item_id=?",
                   (binding, kind, item_id))
    row = db.execute("SELECT COALESCE(MAX(sheet_row),1)+1 FROM google_record_events WHERE binding=?",
                     (binding,)).fetchone()[0]
    db.execute("""
        INSERT INTO google_record_events
        (binding,sheet_row,event_id,captured,source,action,kind,item_id,voice_id,status,title,raw,task_done)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (binding, row, secrets.token_hex(16), now_seoul().isoformat(timespec="seconds"),
          source, action, kind, item_id, voice_id, status, title, encode(raw),
          skip_task))


def voice_payload(title, captured, item_id):
    """Use explicit speech markers. An ambiguous number/date stays as raw input."""
    text = " ".join(unicodedata.normalize("NFKC", title).split())
    prefix = PREFIX.match(text)
    if prefix is None:
        return False, None
    command = text[prefix.end():]
    head, memo_separator, memo = command.partition(" 메모 ")
    when = SPOKEN_TIME.search(head)
    if when and "일정" not in head and (when.start() == 0 or when.end() == len(head)):
        hour, minute = int(when[2]), int(when[3] or 0)
        if when[1]:
            if not 1 <= hour <= 12:
                return True, None
            hour = hour % 12 + (12 if when[1] == "오후" else 0)
        try:
            captured = captured.replace(hour=hour, minute=minute)
        except ValueError:
            return True, None
        command = (head[:when.start()] + head[when.end():]).strip() + memo_separator + memo
    date = captured.isoformat(timespec="minutes").split("+")[0]
    feeding = re.fullmatch(r"수유\s+(분유|모유|혼합|기타)\s*(\d{1,4}(?:\.\d{1,2})?)\s*(" + VOLUME_UNIT + r"|분)(?:\s+메모\s+(.+))?",
                           command, re.IGNORECASE)
    if feeding and float(feeding[2]) > 0:
        unit = "분" if feeding[3] == "분" else "ml"
        return True, ("records", {"id": item_id, "type": "feeding", "date": date,
                                  "category": feeding[1], "amount": feeding[2] + unit, "memo": feeding[4] or ""})
    hospital = re.fullmatch(r"병원\s+(.+?)\s+이유\s+(.+)", command)
    if hospital:
        return True, ("records", {"id": item_id, "type": "hospital", "date": date,
                                  "hospital": hospital[1], "reason": hospital[2]})
    shopping = re.fullmatch(r"(?:구매|장보기)\s+(.+?)\s+수량\s+(.+)", command)
    if shopping:
        return True, ("shopping", {"id": item_id, "title": shopping[1], "quantity": shopping[2], "done": "no"})
    normalized_date = re.sub(
        r"(?<=일정 )([0-9]{4})년\s*([0-9]{1,2})월\s*([0-9]{1,2})일",
        lambda match: f"{int(match[1]):04d}-{int(match[2]):02d}-{int(match[3]):02d}", command,
    )
    schedule = re.fullmatch(r"일정\s+(\d{4}-\d{2}-\d{2})\s+(?:(오전|오후)\s*)?(\d{1,2})"
                            r"(?:\s*:\s*(\d{2})|\s*시(?:\s*(\d{1,2})\s*분)?)\s+(.+)", normalized_date)
    if schedule:
        hour = int(schedule[3])
        if schedule[2]:
            if not 1 <= hour <= 12:
                return True, None
            hour = hour % 12 + (12 if schedule[2] == "오후" else 0)
        try:
            when = datetime.fromisoformat(schedule[1]).replace(hour=hour, minute=int(schedule[4] or schedule[5] or 0))
        except ValueError:
            return True, None
        return True, ("schedule", {"id": item_id, "date": when.isoformat(timespec="minutes"), "title": schedule[6]})
    return True, None


def task_title(kind, item):
    if kind == "records":
        if item.get("type") == "feeding":
            return f"수유 · {item['category']} {item['amount']}"
        if item.get("type") == "sleep":
            return f"수면 · {item['category']} {item['date'][11:16]}" + (f"~{item['end'][11:16]}" if item.get("end") else "")
        if item.get("type") == "diaper":
            return f"기저귀 · {item['category']} {item['date'][11:16]}"
        return f"병원 · {item['hospital']}"
    return ("일정 · " if kind == "schedule" else "구매 · ") + item["title"]


def task_marker(binding, kind, item_id):
    return "[솜하우스 " + hashlib.sha256(encode([binding, kind, item_id]).encode()).hexdigest() + "]"


class GoogleRecords:
    def __init__(self, store, config):
        from calendar_records import CalendarRecords
        from shopping_records import ShoppingRecords

        self.store, self.config = store, config
        self.binding = config["binding"]
        self.api = GoogleAPI(config)
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.calendar = None
        inbox, outbox = config.get("calendar_inbox"), config.get("calendar_outbox")
        if isinstance(inbox, str) and isinstance(outbox, str) and inbox and outbox and inbox != outbox:
            self.calendar = CalendarRecords(self)
        self.shopping = ShoppingRecords(self)
        credential_hash = hashlib.sha256(encode([config.get("client_id"), config.get("refresh_token")]).encode()).hexdigest()
        with self.store.lock, self.store.connect() as db:
            source = db.execute("SELECT sheet_id FROM google_sheet_state WHERE binding=?", (self.binding,)).fetchone()
            if source and self.api.sheet_id is None:
                self.api.sheet_id = source[0]
            db.execute("""INSERT INTO google_auth_state VALUES (?,?,'ready')
                ON CONFLICT(binding) DO UPDATE SET credential_hash=excluded.credential_hash,
                state=CASE WHEN credential_hash=excluded.credential_hash THEN state ELSE 'ready' END""",
                       (self.binding, credential_hash))
            self.auth_state = db.execute("SELECT state FROM google_auth_state WHERE binding=?", (self.binding,)).fetchone()[0]

    def adopt_credentials(self, client_id, client_secret, refresh_token, access_token, extra=None):
        """Switch to credentials renewed from the web: same account and resources, new client and refresh token."""
        updated = {**self.config, **(extra or {}), "client_id": client_id, "client_secret": client_secret,
                   "refresh_token": refresh_token}
        save_config(self.store.directory, updated)
        self.config.update(updated)  # GoogleAPI and the Calendar/shopping helpers share this dict
        self.api.token, self.api.expires = access_token, time.monotonic() + 3000
        credential_hash = hashlib.sha256(encode([client_id, refresh_token]).encode()).hexdigest()
        with self.store.lock, self.store.connect() as db:
            db.execute("""INSERT INTO google_auth_state VALUES (?,?,'ready') ON CONFLICT(binding) DO UPDATE
                SET credential_hash=excluded.credential_hash, state='ready'""", (self.binding, credential_hash))
            db.execute("UPDATE google_service_state SET attempts=0,next_retry_at=0 WHERE binding=?", (self.binding,))
        self.auth_state = "ready"
        self.wake.set()

    def renew(self, config, access_token, made):
        """Adopt a reconnect from the phone that may also have (re)made resources (see google_setup.provision).

        What lived in a recreated resource is sent again: every sheet row (same row numbers, so the history
        is complete again), the current Tasks copy of each existing record, and each feeding in the calendar.
        A calendar granted for the first time starts with the same projection.
        """
        from calendar_records import CalendarRecords

        resources = {key: config[key] for key in ("task_list", "spreadsheet", "source_sheet_id", "calendar_inbox",
                                                   "calendar_outbox", "calendar_write") if key in config}
        # Hold the store lock throughout so the worker never pairs new resources with old links.
        with self.store.lock:
            self.adopt_credentials(config["client_id"], config["client_secret"], config["refresh_token"],
                                   access_token, resources)
            self.api.sheet_id, self.api.sheet_size = self.config.get("source_sheet_id"), None
            if self.config.get("calendar_outbox"):
                if self.calendar is None:
                    self.calendar = CalendarRecords(self)
                self.calendar.inbox = self.config["calendar_inbox"]
                self.calendar.outbox = self.config["calendar_outbox"]
            with self.store.connect() as db:
                if "sheet" in made:
                    db.execute("UPDATE google_record_events SET sheet_done=0 WHERE binding=?", (self.binding,))
                    if self.api.sheet_id is not None:
                        db.execute("INSERT OR REPLACE INTO google_sheet_state VALUES (?,?)", (self.binding, self.api.sheet_id))
                    else:
                        db.execute("DELETE FROM google_sheet_state WHERE binding=?", (self.binding,))
                if "tasks" in made:
                    db.execute("DELETE FROM google_task_links WHERE binding=?", (self.binding,))
                    # Only the latest event of each record that still exists: deleted records leave nothing behind.
                    db.execute("""UPDATE google_record_events SET task_done=0 WHERE seq IN (
                        SELECT MAX(seq) FROM google_record_events e WHERE binding=? AND EXISTS (
                            SELECT 1 FROM items i WHERE i.kind=e.kind AND i.id=e.item_id)
                        GROUP BY kind, item_id)""", (self.binding,))
                if "calendar" in made:
                    db.execute("DELETE FROM google_calendar_links WHERE binding=?", (self.binding,))
                    db.execute("DELETE FROM google_calendar_jobs WHERE binding=?", (self.binding,))
                    for item_id, body in db.execute("SELECT id,body FROM items WHERE kind='records'").fetchall():
                        self.calendar.queue(db, "records", item_id, json.loads(body), "save")
                targets = {"sheet": "sheets", "tasks": "tasks", "calendar": "calendar"}
                for name in made:
                    db.execute("DELETE FROM google_delivery_retries WHERE binding=? AND target=?",
                               (self.binding, targets[name]))
        self.wake.set()

    @classmethod
    def load(cls, store):
        config = load_config(store.directory)
        if config is None and (store.directory / CONFIG_NAME).exists():
            print("Google 기록 연동 비활성: 유효한 연결 설정이 없습니다. Keep으로 자동 전환하지 않습니다.", file=sys.stderr, flush=True)
        return cls(store, config) if config else None

    def account_query(self):
        """?authuser=… so a phone signed in to several Google accounts opens the connected one."""
        email = getattr(self, "email", "")
        return "?authuser=" + quote(email, safe="@") if email else ""

    def load_email(self):
        """The connected account's address, read once from Google (openid + email scopes)."""
        identity = self.api.request("https://openidconnect.googleapis.com/v1/userinfo", service="Google 계정")
        email = identity.get("email")
        if identity.get("sub") == self.config.get("subject") and identity.get("email_verified") is True \
                and isinstance(email, str) and re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", email):
            self.email = email

    def sources(self):
        query = self.account_query()
        sources = {"tasks": TASKS_WEB + query,
                   "sheet": f"https://docs.google.com/spreadsheets/d/{self.config['spreadsheet']}/edit{query}"}
        if self.calendar:
            sources["calendar"] = "https://calendar.google.com/calendar/r" + query
        return sources

    def status(self, db):
        pending = {}
        for target, table, condition in (
            ("sheets", "google_record_events", "sheet_done=0"),
            ("tasks", "google_record_events", "task_done=0"),
            ("calendar", "google_calendar_jobs", "1=1"),
            ("shopping", "google_shopping_jobs", "task_done=0"),
        ):
            count = db.execute(f"SELECT COUNT(*) FROM {table} WHERE binding=? AND {condition}", (self.binding,)).fetchone()[0]
            failed, retrying = db.execute("""SELECT COALESCE(SUM(failed),0), COALESCE(SUM(1-failed),0)
                FROM google_delivery_retries WHERE binding=? AND target=?""", (self.binding, target)).fetchone()
            row = db.execute("SELECT last_success,last_error FROM google_service_state WHERE binding=? AND target=?",
                             (self.binding, target)).fetchone()
            retry = db.execute("""SELECT last_error FROM google_delivery_retries WHERE binding=? AND target=?
                                  ORDER BY next_retry_at DESC LIMIT 1""", (self.binding, target)).fetchone()
            pending[target] = {"pending": count, "failed": failed, "retrying": retrying,
                               "last_success": row[0] if row else None,
                               "last_error": retry[0] if retry else row[1] if row else ""}
        review = db.execute("SELECT COUNT(*) FROM google_voice_receipts WHERE binding=? AND accepted=0",
                            (self.binding,)).fetchone()[0]
        review += db.execute("SELECT COUNT(*) FROM google_calendar_inputs WHERE binding=? AND review=1",
                             (self.binding,)).fetchone()[0]
        imports = [dict(target=target, last_error=error) for target, error in db.execute(
            "SELECT target,last_error FROM google_service_state WHERE binding=? AND last_error<>''",
            (self.binding,))]
        result = {"auth_state": self.auth_state, "services": pending, "review": review, "errors": imports,
                  "calendar_write": bool(self.calendar and self.calendar.can_write)}
        if result["calendar_write"]:
            result["writeback_ready"], result["writeback_pending"] = self.calendar.writeback_state(db)
        if self.calendar:
            result["feeding_alarm"] = self.calendar.alarm.status(db)
        if review:
            result["review_items"] = self.review_items(db)
        return result

    def review_items(self, db, limit=20):
        """Voice inputs that were not saved automatically, newest first, for correction on the web."""
        from calendar_records import SLEEP_KINDS, SLEEP_WORDS, load_aliases, scan_feeding

        aliases = load_aliases(db)

        def entry(key, source, title, when, status):
            text = " ".join(unicodedata.normalize("NFKC", title or "").split())
            found = scan_feeding(PREFIX.sub("", text), aliases)
            amount = found["amounts"][0] if found["amounts"] else None
            # Minutes are only used for 모유 (breastfeeding), so suggest it when no kind was heard.
            minutes = bool(amount and amount[1] == "분")
            suggest = {"category": found["kinds"][0] if found["kinds"] else ("모유" if minutes else "기타"),
                       "amount": (amount[0] + ("분" if amount[1] == "분" else "ml")) if amount else ""}
            words = set(PREFIX.sub("", text).replace(".", " ").split())
            if words & SLEEP_WORDS and not found["kinds"] and not found["generic"]:
                suggest = {"type": "sleep", "category": next((k for k in SLEEP_KINDS if k in words), "")}
            return {"key": key, "source": source, "title": title or "", "when": when or "", "status": status,
                    "suggest": suggest}

        items = []
        for voice_id, captured in db.execute("""SELECT voice_id,captured FROM google_voice_receipts
                WHERE binding=? AND accepted=0 ORDER BY rowid DESC LIMIT ?""", (self.binding, limit)).fetchall():
            row = db.execute("""SELECT title,status FROM google_record_events WHERE binding=? AND source='tasks'
                AND voice_id=? ORDER BY seq DESC LIMIT 1""", (self.binding, voice_id)).fetchone()
            items.append(entry("tasks:" + voice_id, "Tasks", row[0] if row else "", (captured or "")[:16],
                               row[1] if row else "확인 필요"))
        for event_id, item_id in db.execute("""SELECT event_id,item_id FROM google_calendar_inputs
                WHERE binding=? AND review=1 ORDER BY rowid DESC LIMIT ?""", (self.binding, limit)).fetchall():
            row = db.execute("""SELECT title,status,raw FROM google_record_events WHERE binding=? AND source='calendar'
                AND item_id=? ORDER BY seq DESC LIMIT 1""", (self.binding, item_id)).fetchone()
            when = ""
            try:
                start = json.loads(row[2])["event"]["start"]["dateTime"]
                when = datetime.fromisoformat(start).astimezone(SEOUL).isoformat(timespec="minutes")[:16]
            except (TypeError, KeyError, ValueError):
                pass
            items.append(entry("calendar:" + event_id, "Calendar", row[0] if row else "", when,
                               row[1] if row else "확인 필요"))
        return items

    def resolve_review(self, db, key, action, kind=None, item=None):
        """Save a corrected record for an unresolved voice input, or dismiss it. The Google source is untouched.

        The record ID is the one automatic import would have used, so a repeated or late resolution
        updates the same record instead of creating a duplicate.
        """
        source, _, identifier = key.partition(":")
        if source == "tasks":
            if not db.execute("SELECT 1 FROM google_voice_receipts WHERE binding=? AND voice_id=? AND accepted=0",
                              (self.binding, identifier)).fetchone():
                raise LookupError(key)
            item_id = "task-" + hashlib.sha256(encode([self.binding, identifier]).encode()).hexdigest()
            done = ("UPDATE google_voice_receipts SET accepted=1 WHERE binding=? AND voice_id=?",
                    (self.binding, identifier))
        elif source == "calendar" and self.calendar:
            row = db.execute("""SELECT item_id FROM google_calendar_inputs
                WHERE binding=? AND inbox=? AND event_id=? AND review=1""",
                             (self.binding, self.calendar.inbox, identifier)).fetchone()
            if not row:
                raise LookupError(key)
            item_id = row[0]
            # applied is left as it was, so a later Calendar edit keeps this web correction ("웹 기록 유지").
            done = ("UPDATE google_calendar_inputs SET review=0 WHERE binding=? AND inbox=? AND event_id=?",
                    (self.binding, self.calendar.inbox, identifier))
        else:
            raise LookupError(key)
        if action == "save":
            item = dict(item, id=item_id)
            if kind == "records" and item.get("type") == "feeding":
                # A correction teaches the new word it was said with (부유 -> 분유).
                from calendar_records import learn_alias, load_aliases, scan_feeding
                title = db.execute("""SELECT title FROM google_record_events WHERE binding=? AND item_id=?
                    AND source IN ('tasks','calendar') ORDER BY seq DESC LIMIT 1""", (self.binding, item_id)).fetchone()
                text = " ".join(unicodedata.normalize("NFKC", title[0] if title else "").split())
                found = scan_feeding(PREFIX.sub("", text), load_aliases(db))
                if len(found["heard"]) == 1:
                    item["heard"] = found["heard"][0]
                    learn_alias(db, item["heard"], item.get("category"))
            self.store.snapshot(db)
            db.execute("""INSERT INTO items VALUES (?,?,?)
                ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body""", (kind, item_id, encode(item)))
            self.queue(db, kind, item_id, item, "save")
            self.wake_from_sleep(db, item)
        else:
            queue_event(db, self.binding, "", item_id, {"review": key}, action="dismiss",
                        status="확인 필요 무시", skip_task=True)
        db.execute(*done)
        return item_id

    def require_reconnect(self):
        self.auth_state = "reconnect_required"
        with self.store.lock, self.store.connect() as db:
            db.execute("UPDATE google_auth_state SET state=? WHERE binding=?", (self.auth_state, self.binding))

    def job(self, target, identifier, operation):
        if self.auth_state != "ready" or self.stop.is_set():
            return False
        try:
            operation()
        except GoogleAuthError:
            self.require_reconnect()
            return False
        except (GoogleError, OSError, ValueError, KeyError, TypeError) as error:
            detail = str(error) if isinstance(error, GoogleError) else type(error).__name__
            with self.store.lock, self.store.connect() as db:
                table, condition = {
                    "tasks": ("google_record_events", "seq=? AND task_done=0"),
                    "sheets": ("google_record_events", "seq=? AND sheet_done=0"),
                    "calendar": ("google_calendar_jobs", "revision=?"),
                    "shopping": ("google_shopping_jobs", "item_id=? AND task_done=0"),
                }[target]
                if not db.execute(f"SELECT 1 FROM {table} WHERE binding=? AND {condition}",
                                  (self.binding, identifier)).fetchone():
                    return False
                failure(db, self.binding, target, identifier, detail)
            self.log(target, error)
            return False
        with self.store.lock, self.store.connect() as db:
            success(db, self.binding, target, identifier, now_seoul().isoformat(timespec="seconds"))
        return True

    def queue(self, db, kind, item_id, item, action):
        if item is not None:
            original = db.execute("""
                SELECT voice_id FROM google_record_events
                WHERE binding=? AND source='tasks' AND item_id=? AND status='저장' LIMIT 1
            """, (self.binding, item_id)).fetchone()
            queue_event(db, self.binding, kind, item_id, item, action=action,
                        voice_id=original[0] if original else "", title=task_title(kind, item))
            if self.calendar:
                self.calendar.queue(db, kind, item_id, item, action)

    def wake_from_sleep(self, db, feeding):
        """A feeding from any input ends the open sleep; the change goes to Google like a web edit."""
        from sleep_wake import end_sleep_on_feeding
        sleep = end_sleep_on_feeding(db, feeding)
        if sleep:
            self.queue(db, "records", sleep["id"], sleep, "save")
        return sleep

    def backfill(self, db):
        count = 0
        for kind, item_id, body in db.execute("SELECT kind,id,body FROM items ORDER BY rowid").fetchall():
            digest = hashlib.sha256(body.encode()).hexdigest()
            added = db.execute("INSERT OR IGNORE INTO google_backfill_receipts VALUES (?,?,?,?)",
                               (self.binding, kind, item_id, digest)).rowcount
            if not added:
                continue
            if db.execute("""SELECT 1 FROM google_record_events WHERE binding=? AND kind=? AND item_id=?
                             AND raw=? AND action<>'delete'""", (self.binding, kind, item_id, body)).fetchone():
                continue
            self.queue(db, kind, item_id, json.loads(body), "save")
            count += 1
        return count

    def record_voice(self, task):
        from shopping_records import purchase_payload

        if not isinstance(task, dict) or task.get("deleted"):
            return
        voice_id, title = task.get("id"), task.get("title")
        if not isinstance(voice_id, str) or not isinstance(title, str) or len(title) > 16000:
            return
        item_id = "task-" + hashlib.sha256(encode([self.binding, voice_id]).encode()).hexdigest()
        captured = now_seoul()
        try:
            updated = datetime.fromisoformat(task.get("updated", ""))
            if updated.tzinfo is not None:
                captured = updated.astimezone(SEOUL)
        except (TypeError, ValueError):
            pass
        with self.store.connect() as db:
            receipt = db.execute("SELECT captured FROM google_voice_receipts WHERE binding=? AND voice_id=?",
                                 (self.binding, voice_id)).fetchone()
        if receipt and receipt[0]:
            captured = datetime.fromisoformat(receipt[0])
        tagged, parsed = voice_payload(title, captured, item_id)
        purchase = purchase_payload(title, item_id, self.shopping.settings)
        if purchase:
            if task.get("status") == "completed":
                if not tagged:
                    return
                purchase["done"] = "yes"
            tagged, parsed = True, ("shopping", purchase)
        if not tagged:
            return
        fingerprint = hashlib.sha256(encode([title, task.get("notes"), task.get("due")]).encode()).hexdigest()
        with self.store.lock, self.store.connect() as db:
            row = db.execute("SELECT fingerprint,accepted FROM google_voice_receipts WHERE binding=? AND voice_id=?",
                             (self.binding, voice_id)).fetchone()
            if row and (row[0] == fingerprint or row[1]):
                return
            if parsed:
                kind, item = parsed
                if db.execute("SELECT 1 FROM items WHERE kind=? AND id=?", (kind, item_id)).fetchone() is None:
                    self.store.snapshot(db)
                    db.execute("INSERT INTO items VALUES (?,?,?)", (kind, item_id, encode(item)))
                    if self.calendar:
                        self.calendar.queue(db, kind, item_id, item)
                    self.wake_from_sleep(db, item)
                    if purchase and purchase["done"] != "yes":
                        self.shopping.queue(db, item, task)
            else:
                kind = ""
            queue_event(db, self.binding, kind, item_id, task, source="tasks", action="import",
                        voice_id=voice_id, title=title, status="저장" if parsed else "확인 필요")
            db.execute("INSERT OR REPLACE INTO google_voice_receipts (binding,voice_id,fingerprint,accepted,captured) VALUES (?,?,?,?,?)",
                       (self.binding, voice_id, fingerprint, bool(parsed), captured.isoformat()))

    def deliver_task(self, event):
        _, _, _, _, source, action, kind, item_id, _, _, _, raw = event
        item = json.loads(raw)
        if source == "calendar":
            item = item["record"]
        marker = task_marker(self.binding, kind, item_id)
        with self.store.lock, self.store.connect() as db:
            row = db.execute("SELECT task_id FROM google_task_links WHERE binding=? AND kind=? AND item_id=?",
                             (self.binding, kind, item_id)).fetchone()
            if row is None:
                # Reserve before the first insert. Only an uncertain retry has to scan the Tasks list.
                db.execute("INSERT INTO google_task_links VALUES (?,?,?,?)",
                           (self.binding, kind, item_id, ""))
        task_id = row[0] if row else None
        task_list = self.config["task_list"]
        def find_copy():
            return next((task["id"] for task in self.api.tasks(task_list)
                         if task.get("notes", "").splitlines()[:1] == [marker]), None)

        if row is not None and not task_id:
            task_id = find_copy()
        title = task_title(kind, item)
        complete = action == "delete" or item.get("done") == "yes"
        if action == "delete":
            title = "삭제 · " + title
        # The sheet keeps the complete source payload, including long fields.
        notes = f"{marker}\n원본 시트: {self.sources()['sheet']}\n\n{raw[:3900]}"
        body = {"title": title[:500], "notes": notes, "status": "completed" if complete else "needsAction"}
        try:
            task = self.api.put_task(task_list, body, task_id)
        except GoogleError as error:
            if error.status != 404 or not task_id:
                raise
            task = self.api.put_task(task_list, body, find_copy())
        return task["id"]

    def pull(self):
        inbox = self.config["inbox"]
        with self.store.connect() as db:
            checkpoint = db.execute("SELECT updated_min FROM google_inbox_checkpoint WHERE binding=? AND inbox=?",
                                    (self.binding, inbox)).fetchone()
        # Overlap polls so a task updated during pagination is picked up next time.
        next_min = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(timespec="seconds")
        for task in self.api.tasks(inbox, checkpoint[0] if checkpoint else None):
            if self.stop.is_set():
                return
            self.record_voice(task)
        with self.store.lock, self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO google_inbox_checkpoint VALUES (?,?,?)", (self.binding, inbox, next_min))

    def deliver(self, target):
        column = "task_done" if target == "tasks" else "sheet_done"
        with self.store.connect() as db:
            events = db.execute(f"""
                SELECT seq,sheet_row,event_id,captured,source,action,kind,item_id,voice_id,status,title,raw
                FROM google_record_events e WHERE binding=? AND {column}=0
                AND {eligible('e', target, 'e.seq')} ORDER BY seq LIMIT 10
            """, (self.binding,)).fetchall()
        for event in events:
            if self.stop.is_set():
                break
            def send():
                with self.store.connect() as db:
                    if db.execute(f"SELECT {column} FROM google_record_events WHERE seq=?", (event[0],)).fetchone()[0]:
                        return
                task_id = self.deliver_task(event) if target == "tasks" else None
                if target == "sheets":
                    self.deliver_sheet(event)
                with self.store.lock, self.store.connect() as db:
                    if task_id:
                        db.execute("INSERT OR REPLACE INTO google_task_links VALUES (?,?,?,?)",
                                   (self.binding, event[6], event[7], task_id))
                    db.execute(f"UPDATE google_record_events SET {column}=1 WHERE seq=?", (event[0],))
            self.job(target, event[0], send)

    def deliver_sheet(self, event):
        seq, row, identifier, captured, source, action, kind, item_id, voice_id, status, title, raw = event
        values = [identifier, captured, source, action, kind, item_id, voice_id, status, title]
        values += [raw[i:i+20000] for i in range(0, len(raw), 20000)]
        with self.store.connect() as db:
            retry = db.execute("SELECT 1 FROM google_delivery_retries WHERE binding=? AND target='sheets' AND job_id=?",
                               (self.binding, str(seq))).fetchone()
        # An uncertain write may have succeeded and then been moved by a user.
        if retry and any(cell and cell[0] == identifier for cell in self.api.sheet_cell("A:A")):
            return
        try:
            self.api.sheet_row(row, values)
        except GoogleError as error:
            if error.status != "원본 행 충돌":
                raise
            cells = self.api.sheet_cell("A:A")
            if any(cell and cell[0] == identifier for cell in cells):
                return
            with self.store.lock, self.store.connect() as db:
                reserved = db.execute("SELECT COALESCE(MAX(sheet_row),1)+1 FROM google_record_events WHERE binding=?",
                                      (self.binding,)).fetchone()[0]
                row = max(reserved, len(cells) + 1)
                db.execute("UPDATE google_record_events SET sheet_row=? WHERE seq=?", (row, seq))
            self.api.sheet_row(row, values)

    def run(self):
        from fcntl import LOCK_EX, LOCK_NB, flock

        try:
            with (self.store.directory / "google-records.lock").open("a") as lock:
                flock(lock, LOCK_EX | LOCK_NB)
                self.loop()
        except BlockingIOError:
            print("Google 동기화 작업이 이미 실행 중입니다.", file=sys.stderr, flush=True)

    def protect_source(self):
        self.api.protect_source()
        with self.store.lock, self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO google_sheet_state VALUES (?,?)", (self.binding, self.api.sheet_id))

    def loop(self):
        next_poll = next_view = 0
        protected = False
        while not self.stop.is_set():
            self.wake.clear()
            if not protected:
                protected = self.attempt("source_protection", self.protect_source)
            if not getattr(self, "email", ""):
                self.attempt("Google 계정 확인", self.load_email)
            if time.monotonic() >= next_poll:
                next_poll = time.monotonic() + 30
                self.attempt("Tasks 음성 가져오기", self.pull)
                if self.calendar:
                    self.attempt("Calendar 음성 가져오기", self.calendar.pull)
            if self.calendar and time.monotonic() >= next_view:
                next_view = time.monotonic() + 300
                self.attempt("Calendar 일정 보기", self.calendar.refresh_view)
            self.attempt("Sheets", self.deliver, "sheets")
            self.attempt("Tasks", self.deliver, "tasks")
            if self.calendar:
                self.attempt("Calendar", self.calendar.flush)
                self.attempt("Calendar 반영", self.calendar.flush_writebacks)
                self.attempt("밥 알람", self.calendar.alarm.sync)
            self.attempt("장보기 가격비교", self.shopping.flush)
            self.wake.wait(30)

    def attempt(self, stage, operation, *args):
        if not self.stop.is_set() and self.auth_state == "ready":
            with self.store.connect() as db:
                row = db.execute("SELECT attempts,next_retry_at FROM google_service_state WHERE binding=? AND target=?",
                                 (self.binding, stage)).fetchone()
            if row and row[1] > time.time():
                return False
            try:
                operation(*args)
            except GoogleAuthError as error:
                self.require_reconnect()
                self.log(stage, error)
            except (GoogleError, sqlite3.Error, OSError, ValueError, KeyError, TypeError) as error:
                self.log(stage, error)
                attempts = min(8, (row[0] if row else 0) + 1)
                detail = str(error) if isinstance(error, GoogleError) else type(error).__name__
                with self.store.lock, self.store.connect() as db:
                    db.execute("""INSERT INTO google_service_state(binding,target,last_error,attempts,next_retry_at)
                        VALUES (?,?,?,?,?) ON CONFLICT(binding,target) DO UPDATE SET
                        last_error=excluded.last_error, attempts=excluded.attempts, next_retry_at=excluded.next_retry_at""",
                               (self.binding, stage, detail, attempts, time.time() + min(3600, 30 * 2 ** (attempts - 1))))
            else:
                with self.store.lock, self.store.connect() as db:
                    db.execute("UPDATE google_service_state SET last_error='',attempts=0,next_retry_at=0 WHERE binding=? AND target=?",
                               (self.binding, stage))
                return self.auth_state == "ready"
        return False

    @staticmethod
    def log(stage, error):
        detail = str(error) if isinstance(error, GoogleError) else type(error).__name__
        print(f"Google 기록 연동 · {stage} · {detail}", file=sys.stderr, flush=True)
