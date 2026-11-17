"""Import tagged feeding events and mirror local feedings to a widget calendar."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
import unicodedata
from urllib.parse import quote, urlencode

from google_records import GoogleError, PREFIX, SEOUL, encode, queue_event, voice_payload
from google_delivery import eligible


CALENDAR = "https://www.googleapis.com/calendar/v3/calendars"
CALENDAR_WEB = "https://calendar.google.com/calendar/"
CALENDAR_NAME = "솜하우스 수유"
CALENDAR_SCOPES = ("https://www.googleapis.com/auth/calendar.events.owned.readonly",
                   "https://www.googleapis.com/auth/calendar.app.created")
SCHEMA = """
CREATE TABLE IF NOT EXISTS google_calendar_inputs (
    binding TEXT NOT NULL, inbox TEXT NOT NULL, event_id TEXT NOT NULL, item_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, applied TEXT, PRIMARY KEY (binding, inbox, event_id)
);
CREATE INDEX IF NOT EXISTS google_calendar_origin ON google_calendar_inputs(binding,item_id);
CREATE TABLE IF NOT EXISTS google_calendar_checkpoint (
    binding TEXT NOT NULL, inbox TEXT NOT NULL, updated_min TEXT NOT NULL, PRIMARY KEY (binding,inbox)
);
CREATE TABLE IF NOT EXISTS google_calendar_jobs (
    binding TEXT NOT NULL, item_id TEXT NOT NULL, revision TEXT NOT NULL, body TEXT,
    PRIMARY KEY (binding,item_id)
);
CREATE TABLE IF NOT EXISTS google_calendar_links (
    binding TEXT NOT NULL, item_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (binding,item_id)
);
CREATE TABLE IF NOT EXISTS feeding_aliases (word TEXT PRIMARY KEY, category TEXT NOT NULL);
"""


def calendar_url(calendar_id):
    return f"{CALENDAR}/{quote(calendar_id, safe='')}/events"


def event_pages(api, calendar_id, **params):
    url = calendar_url(calendar_id)
    while True:
        response = api.request(url + "?" + urlencode(params), service="Calendar")
        yield from response.get("items", [])
        if not response.get("nextPageToken"):
            break
        params["pageToken"] = response["nextPageToken"]


def parse_time(value):
    if not isinstance(value, str) or ":" not in value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


# Natural Assistant phrasing such as "100미리 수유 캘린더에 업데이트" usually has no 솜하우스 tag,
# and speech recognition may write 수유 as 수육, 분유 as 부유, 미리 as mm, or add a stray number.
# Look-alike words are treated as one family: the feeding is saved, and when the kind is unclear the
# record carries confirm="category" so the family can pick it with one tap. A pick for a new word
# (부유 -> 분유) is remembered in feeding_aliases. The Sheets history keeps the raw event.
NATURAL_AMOUNT = re.compile(r"(\d{1,4}(?:\.\d{1,2})?)\s*(ml|밀리\s*리터|밀리|미리|cc|씨씨|mm|분)(?![A-Za-z유])",
                            re.IGNORECASE)
FEEDING_KINDS = ("분유", "모유", "혼합")
GENERIC_WORD = "수유"
LOOKALIKE = re.compile(r"[가-힣][유육]")
FILLER = {"기록", "캘린더", "업데이트", "추가", "입력", "저장", "완료", "했어", "했음", "함", "먹음", "먹었어", "먹었음", "줬어", "줬음"}
PARTICLE = re.compile(r"(?:에서|으로|에|을|를|로|은|는)$")


def learnable(word):
    """A new look-alike of a kind word. Words starting with 수 are 수유 misheard, which names no kind."""
    return (isinstance(word, str) and bool(LOOKALIKE.fullmatch(word)) and not word.startswith("수")
            and word not in FEEDING_KINDS)


def load_aliases(db):
    return {word: category for word, category in db.execute("SELECT word,category FROM feeding_aliases")
            if category in FEEDING_KINDS}


def learn_alias(db, word, category):
    if learnable(word) and category in FEEDING_KINDS:
        db.execute("INSERT OR REPLACE INTO feeding_aliases VALUES (?,?)", (word, category))
        return True
    return False


def heard_word(item):
    """The new look-alike word a feeding was said with: its heard field, else the memo's 음성 원문."""
    if learnable(item.get("heard")):
        return item["heard"]
    memo = item.get("memo", "")
    if not memo.startswith("음성 원문: "):
        return None
    text = " ".join(unicodedata.normalize("NFKC", memo.removeprefix("음성 원문: ").split(" · ")[0]).split())
    found = scan_feeding(PREFIX.sub("", text)) or {}
    return found["heard"][0] if len(found.get("heard", [])) == 1 else None


def relearn(db, item):
    """Saving a feeding with a kind teaches the word it was said with, so a later edit corrects a wrong pick."""
    if item.get("type") != "feeding" or item.get("category") not in FEEDING_KINDS:
        return False
    return learn_alias(db, heard_word(item), item["category"])


def scan_feeding(text, aliases=None):
    """Classify the words of a normalized title. Returns None when it has no unit-bearing amount."""
    aliases = aliases or {}
    amounts = NATURAL_AMOUNT.findall(text)
    if not amounts:
        return None
    found = {"amounts": amounts, "kinds": [], "generic": False, "learned": [], "heard": [], "misheard": False,
             "stray": [], "leftover": []}
    for token in NATURAL_AMOUNT.sub(" ", text).replace(".", " ").split():
        token = PARTICLE.sub("", token)
        kinds = [word for word in FEEDING_KINDS if word in token]
        if kinds or GENERIC_WORD in token:
            found["kinds"] += kinds
            found["generic"] |= GENERIC_WORD in token
            for word in (*FEEDING_KINDS, GENERIC_WORD):
                token = token.replace(word, "")
        if not token or token in FILLER:
            continue
        if token in aliases:
            found["kinds"].append(aliases[token])
            found["learned"].append(token)
        elif learnable(token):
            found["heard"].append(token)
        elif LOOKALIKE.fullmatch(token):
            found["misheard"] = True
        elif token.isdigit():
            # A lone number next to a unit-bearing amount is a recognition artefact ("수육 기록 1 100mm").
            found["stray"].append(token)
        else:
            found["leftover"].append(token)
    found["kinds"] = list(dict.fromkeys(found["kinds"]))
    return found


def natural_feeding(text, when, item_id, title, aliases=None):
    """Return (tagged, item). tagged=False ignores the event; item=None leaves it for review."""
    found = scan_feeding(text, aliases)
    if not found:
        return False, None
    known = bool(found["kinds"]) or found["generic"]
    if not known and not found["heard"] and not found["misheard"]:
        return False, None
    # A look-alike is only read as a feeding next to a volume; "수육 30분" is a cooking time.
    if not known and all(unit == "분" for _, unit in found["amounts"]):
        return False, None
    value, unit = found["amounts"][0]
    # Unknown words, a second amount, two kinds or two new words are kept for a person to check.
    if (len(found["amounts"]) != 1 or found["leftover"] or len(found["kinds"]) > 1 or len(found["heard"]) > 1
            or float(value) <= 0 or not when):
        return True, None
    unit = unit.lower()
    corrected = bool(found["heard"] or found["learned"] or found["misheard"] or found["stray"]) or unit in ("mm", "밀리")
    item = {"id": item_id, "type": "feeding",
            "date": when.astimezone(SEOUL).replace(tzinfo=None).isoformat(timespec="minutes"),
            "category": found["kinds"][0] if found["kinds"] else "기타",
            "amount": value + ("분" if unit == "분" else "ml"),
            "memo": f"음성 원문: {title}" if corrected else ""}
    if not found["kinds"]:
        item["confirm"] = "category"
    if found["heard"] or found["learned"]:
        item["heard"] = (found["heard"] or found["learned"])[0]
    return True, item


QUICK_ENTRY = timedelta(hours=2)


def entry_time(event):
    """Return (when, note) for a feeding event typed or spoken on any device.

    Nest sets the start to the moment of speaking. A hand-typed event usually keeps the app's default
    start (the next slot, shortly after it was created) or is all-day; both mean "just now", so the
    creation time is used. This depends only on the event, never on the clock, so re-reading the same
    event always gives the same record time. A start further ahead stays a future plan for review.
    """
    start = event.get("start")
    start = start if isinstance(start, dict) else {}
    when, created = parse_time(start.get("dateTime")), parse_time(event.get("created"))
    if when and when.tzinfo is None:
        when = None
    if created and created.tzinfo is None:
        created = None
    if when is None:
        if created and start.get("date") == created.astimezone(SEOUL).date().isoformat():
            return created, "종일 일정이라 입력한 시각으로 저장"
        return None, ""
    if created and timedelta(0) < when - created <= QUICK_ENTRY:
        planned = when.astimezone(SEOUL).strftime("%H:%M")
        return created, f"일정 시각 {planned} 대신 입력한 시각으로 저장"
    return when, ""


def calendar_feeding(event, item_id, aliases=None):
    when, note = entry_time(event) if isinstance(event.get("summary", ""), str) else (None, "")
    tagged, item = parse_feeding(event, item_id, when, aliases)
    if item and note:
        item["memo"] = " · ".join(part for part in (item.get("memo", ""), note) if part)
    return tagged, item


def parse_feeding(event, item_id, when, aliases=None):
    title = event.get("summary", "")
    if not isinstance(title, str):
        return False, None
    text = " ".join(unicodedata.normalize("NFKC", title).split())
    prefix = PREFIX.match(text)
    if not prefix:
        return natural_feeding(text, when, item_id, title, aliases)
    command = reformat_feeding(text[prefix.end():].rstrip("."))
    if not (command == "수유" or command.startswith(("수유 ", "분유 ", "모유 ", "혼합 ", "기타 "))):
        return natural_feeding(command, when, item_id, title, aliases)
    if not command.startswith("수유"):
        command = "수유 " + command
    if not when:
        return True, None
    _, parsed = voice_payload("솜하우스 " + command, when.astimezone(SEOUL), item_id)
    if not parsed or parsed[0] != "records" or parsed[1]["type"] != "feeding":
        # Tagged feeding: never drop it; a clean natural phrase is saved, the rest goes to review.
        return True, natural_feeding(command, when, item_id, title, aliases)[1]
    parsed[1]["date"] = when.astimezone(SEOUL).replace(tzinfo=None).isoformat(timespec="minutes")
    return True, parsed[1]


def reformat_feeding(command):
    for separator in (" · ", ": ", "： "):
        if command.startswith("수유" + separator):
            return "수유 " + command.removeprefix("수유" + separator)
    return command


MERGED_FIELDS = ("date", "amount", "category", "memo")


def merge_edit(applied, current, item):
    """Combine a Calendar edit with web edits of the same record, field by field.

    applied is what Calendar last wrote, current is the record now (possibly edited on the web), item is
    the new Calendar reading. A field changed on one side only is taken from that side, so picking the
    kind on the web does not block a later time or amount fix in Calendar. Returns None when the record
    was deleted on the web, was never written by Calendar, or both sides changed one field differently.
    """
    if not applied or not current:
        return None
    old, web = json.loads(applied), json.loads(current)
    merged = dict(web)
    for key in MERGED_FIELDS:
        new = item.get(key, "")
        if new == old.get(key, ""):
            continue
        if web.get(key, "") not in (old.get(key, ""), new):
            return None
        merged[key] = new
    return merged


class CalendarRecords:
    def __init__(self, records):
        self.records, self.store = records, records.store
        self.binding = records.binding
        self.inbox, self.outbox = records.config["calendar_inbox"], records.config["calendar_outbox"]

    @property
    def api(self):
        return self.records.api

    def queue(self, db, kind, item_id, item, action="save"):
        if kind != "records":
            return
        feeding = item.get("type") == "feeding"
        if not feeding and not db.execute("""
            SELECT 1 FROM google_calendar_links WHERE binding=? AND item_id=?
            UNION ALL SELECT 1 FROM google_calendar_jobs WHERE binding=? AND item_id=? LIMIT 1
        """, (self.binding, item_id, self.binding, item_id)).fetchone():
            return
        if db.execute("SELECT 1 FROM google_calendar_inputs WHERE binding=? AND item_id=?",
                      (self.binding, item_id)).fetchone():
            return
        # Invalid legacy dates can still be saved by the web app. They have no Calendar projection.
        body = encode(item) if feeding and action != "delete" and parse_time(item.get("date")) else None
        db.execute("""
            INSERT INTO google_calendar_jobs VALUES (?,?,?,?)
            ON CONFLICT(binding,item_id) DO UPDATE SET revision=excluded.revision, body=excluded.body
        """, (self.binding, item_id, secrets.token_hex(16), body))
        db.execute("""DELETE FROM google_delivery_retries WHERE binding=? AND target='calendar'
            AND job_id NOT IN (SELECT revision FROM google_calendar_jobs WHERE binding=?)""",
                   (self.binding, self.binding))

    def record(self, event):
        if not isinstance(event, dict):
            return
        event_id = event.get("id")
        extensions = event.get("extendedProperties") or {}
        if ((extensions.get("private") or {}).get("somhouseProjection") == "1"
                or not isinstance(event_id, str) or not event_id
                or event.get("recurrence") or event.get("recurringEventId")):
            return
        cancelled = event.get("status") == "cancelled"
        item_id = "cal-" + hashlib.sha256(encode([self.binding, self.inbox, event_id]).encode()).hexdigest()
        with self.store.connect() as db:
            aliases = load_aliases(db)
        tagged, item = calendar_feeding(event, item_id, aliases)
        raw = {key: event[key] for key in ("id", "summary", "start", "end", "updated", "status", "htmlLink")
               if key in event}
        fingerprint = encode([cancelled, raw.get("summary"), raw.get("start")])
        source_key = self.binding, self.inbox, event_id
        with self.store.lock, self.store.connect() as db:
            previous = db.execute("""
                SELECT fingerprint,applied FROM google_calendar_inputs WHERE binding=? AND inbox=? AND event_id=?
            """, source_key).fetchone()
            if not tagged and not cancelled and not previous:
                return
            if (previous and previous[0] == fingerprint) or (cancelled and not previous):
                return
            applied = previous[1] if previous else None
            current = db.execute("SELECT body FROM items WHERE kind='records' AND id=?", (item_id,)).fetchone()
            current = current[0] if current else None
            action, status, projected = "import", "확인 필요", None
            future = bool(item and datetime.fromisoformat(item["date"]).replace(tzinfo=SEOUL) > datetime.now(SEOUL))
            if cancelled or not tagged or future:
                action = "delete" if not future or applied else "import"
                if applied and current == applied:
                    self.store.snapshot(db)
                    db.execute("DELETE FROM items WHERE kind='records' AND id=?", (item_id,))
                    projected, status = json.loads(applied), "저장"
                    applied = None
                else:
                    status = "웹 기록 유지"
            elif item and not future:
                if current == applied:
                    body = encode(item)
                    if current != body:
                        self.store.snapshot(db)
                        db.execute("""
                            INSERT INTO items VALUES ('records',?,?)
                            ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body
                        """, (item_id, body))
                        projected = item
                    applied, status = body, "저장"
                else:
                    merged = merge_edit(applied, current, item)
                    if merged is None:
                        status = "웹 기록 유지"
                    else:
                        body = encode(merged)
                        if current != body:
                            self.store.snapshot(db)
                            db.execute("UPDATE items SET body=? WHERE kind='records' AND id=?", (body, item_id))
                            projected = merged
                        # applied keeps the Calendar side, so the next edit is again compared field by field.
                        applied, status = encode(item), "저장"
            review = future or status in ("확인 필요", "웹 기록 유지")
            if future:
                status = "확인 필요 · 미래 수유 시각"
            queue_event(db, self.binding, "records", item_id, {"event": raw, "record": projected or item},
                        source="calendar", action=action, title=raw.get("summary", ""),
                        status=status, skip_task=projected is None)
            db.execute("INSERT OR REPLACE INTO google_calendar_inputs (binding,inbox,event_id,item_id,fingerprint,applied,review) VALUES (?,?,?,?,?,?,?)",
                       (*source_key, item_id, fingerprint, applied, review))

    def pull(self):
        with self.store.connect() as db:
            checkpoint = db.execute("""
                SELECT updated_min FROM google_calendar_checkpoint WHERE binding=? AND inbox=?
            """, (self.binding, self.inbox)).fetchone()
        now = datetime.now(timezone.utc)
        filters = ({"updatedMin": checkpoint[0]} if checkpoint
                   else {"timeMin": (now - timedelta(days=7)).isoformat(timespec="seconds")})
        for event in event_pages(self.api, self.inbox, maxResults=250, showDeleted="true", **filters):
            if self.records.stop.is_set():
                return
            self.record(event)
        with self.store.lock, self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO google_calendar_checkpoint VALUES (?,?,?)",
                       (self.binding, self.inbox, (now - timedelta(minutes=2)).isoformat(timespec="seconds")))

    def flush(self):
        with self.store.connect() as db:
            jobs = db.execute(f"""
                SELECT item_id,revision,body FROM google_calendar_jobs j WHERE binding=?
                AND {eligible('j', 'calendar', 'j.revision')} ORDER BY rowid LIMIT 10
            """, (self.binding,)).fetchall()
        for item_id, revision, raw in jobs:
            if self.records.stop.is_set():
                return
            self.records.job("calendar", revision, lambda: self.deliver(item_id, revision, raw))

    def deliver(self, item_id, revision, raw):
        with self.store.connect() as db:
            if not db.execute("SELECT 1 FROM google_calendar_jobs WHERE binding=? AND item_id=? AND revision=?",
                              (self.binding, item_id, revision)).fetchone():
                return
        with self.store.lock, self.store.connect() as db:
            link = db.execute("SELECT event_id FROM google_calendar_links WHERE binding=? AND item_id=?",
                              (self.binding, item_id)).fetchone()
            if link is None and raw is not None:
                event_id = secrets.token_hex(20)
                db.execute("INSERT INTO google_calendar_links VALUES (?,?,?)", (self.binding, item_id, event_id))
            else:
                event_id = link[0] if link else None
        if raw is None:
            if event_id:
                self.remove_event(event_id)
        else:
            self.write_event(event_id, json.loads(raw), new=link is None)
        with self.store.lock, self.store.connect() as db:
            if raw is None:
                db.execute("DELETE FROM google_calendar_links WHERE binding=? AND item_id=?",
                           (self.binding, item_id))
            db.execute("DELETE FROM google_calendar_jobs WHERE binding=? AND item_id=? AND revision=?",
                       (self.binding, item_id, revision))

    def remove_event(self, event_id):
        try:
            self.api.request(f"{calendar_url(self.outbox)}/{event_id}?sendUpdates=none", "DELETE", service="Calendar")
        except GoogleError as error:
            if error.status not in (404, 410):
                raise

    def write_event(self, event_id, item, *, new):
        start = parse_time(item["date"])
        start = start.replace(tzinfo=SEOUL) if start.tzinfo is None else start.astimezone(SEOUL)
        end = start + timedelta(minutes=5)
        payload = {
            "summary": ("솜하우스 수유 · " + item["category"] + " " + item["amount"])[:250],
            "start": {"dateTime": start.isoformat(), "timeZone": "Asia/Seoul"},
            "end": {"dateTime": end.isoformat(), "timeZone": "Asia/Seoul"},
            "transparency": "transparent", "reminders": {"useDefault": False},
            "extendedProperties": {"private": {"somhouseProjection": "1"}},
        }
        url = calendar_url(self.outbox)
        if not new:
            try:
                self.api.request(f"{url}/{event_id}?sendUpdates=none", "PATCH", payload, "Calendar")
                return
            except GoogleError as error:
                if error.status not in (404, 410):
                    raise
        try:
            self.api.request(url + "?sendUpdates=none", "POST", {**payload, "id": event_id}, "Calendar")
        except GoogleError as error:
            if error.status != 409:
                raise
            try:
                self.api.request(f"{url}/{event_id}?sendUpdates=none", "PATCH", payload, "Calendar")
            except GoogleError as conflict:
                if conflict.status in (404, 410):
                    # A deleted Calendar event can keep reserving its ID. Persist a replacement for the next attempt.
                    with self.store.lock, self.store.connect() as db:
                        db.execute("UPDATE google_calendar_links SET event_id=? WHERE binding=? AND event_id=?",
                                   (secrets.token_hex(20), self.binding, event_id))
                raise
