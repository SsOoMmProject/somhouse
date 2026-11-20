"""Import tagged feeding events and mirror local feedings to a widget calendar."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
import time
import unicodedata
from urllib.parse import quote, urlencode

from google_records import GoogleError, PREFIX, SEOUL, encode, queue_event, voice_payload
from google_delivery import eligible
from feeding_alarm import FeedingAlarm, NapAlarm, StockAlarm


CALENDAR = "https://www.googleapis.com/calendar/v3/calendars"
CALENDAR_WEB = "https://calendar.google.com/calendar/"
CALENDAR_NAME = "솜하우스 수유"
# Read/write on calendars the user owns: needed only to write a web correction back to the original
# event, and only through the guarded writeback below (docs/CALENDAR_WRITEBACK_PLAN.md).
WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned"
CALENDAR_SCOPES = (WRITE_SCOPE, "https://www.googleapis.com/auth/calendar.app.created")
WRITE_LIMIT, WRITE_WINDOW = 3, 24 * 3600
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
CREATE TABLE IF NOT EXISTS google_calendar_writebacks (
    binding TEXT NOT NULL, event_id TEXT NOT NULL, item_id TEXT NOT NULL, requested_at REAL NOT NULL,
    PRIMARY KEY (binding,event_id)
);
CREATE TABLE IF NOT EXISTS google_calendar_writes (
    binding TEXT NOT NULL, event_id TEXT NOT NULL, written_at REAL NOT NULL, fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_calendar_view (
    binding TEXT NOT NULL, event_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    all_day INTEGER NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL, PRIMARY KEY (binding,event_id)
);
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
    found = scan_feeding(PREFIX.sub("", text))
    return found["heard"][0] if len(found["heard"]) == 1 else None


def relearn(db, item):
    """Saving a feeding with a kind teaches the word it was said with, so a later edit corrects a wrong pick."""
    if item.get("type") != "feeding" or item.get("category") not in FEEDING_KINDS:
        return False
    return learn_alias(db, heard_word(item), item["category"])


def scan_feeding(text, aliases=None):
    """Classify the words of a normalized title."""
    aliases = aliases or {}
    amounts = NATURAL_AMOUNT.findall(text)
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
    known = bool(found["kinds"]) or found["generic"]
    if not found["amounts"]:
        # Only feeding words the family uses ("뷰유", "분유 수유"): surely a feeding, but the amount must
        # be asked. Anything else without an amount is an ordinary event.
        clean = not (found["heard"] or found["misheard"] or found["stray"] or found["leftover"])
        return (True, None) if known and clean else (False, None)
    if not known and not found["heard"] and not found["misheard"]:
        return False, None
    # Minutes are only used for breastfeeding, so a 유-word with minutes ("머유 10분") is likely 모유: keep it for a
    # person to check instead of saving it. A 육-word with minutes ("수육 30분") is a cooking time and is ignored.
    if not known and all(unit == "분" for _, unit in found["amounts"]):
        return (True, None) if any(word.endswith("유") for word in found["heard"]) else (False, None)
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


# Sleep is told apart from feeding by its own words, compared as whole words so 잠실 or 잠깐 never match.
SLEEP_KINDS = ("낮잠", "밤잠")
SLEEP_WORDS = {"수면", "잠", "낮잠", "밤잠", "꿀잠", "잠듦", "잠들었어", "잠들었음", "잤어", "잤음", "잠잠",
               "재움", "재웠어", "재웠음"}
SLEEP_EXTRA = {"아기", "애기", "아가", "시작", "끝"}
SLEEP_LENGTH = re.compile(r"(\d{1,2})\s*시간(?:\s*(\d{1,2})\s*분)?|(\d{1,3})\s*분")
VOLUME = re.compile(r"\d\s*(?:ml|밀리|미리|cc|씨씨|mm)", re.IGNORECASE)
FEEDING_TERMS = re.compile(r"수유|분유|모유|혼합|수육")


def natural_sleep(text, event, item_id, when, note):
    """Return None when the title has no sleep word, else (True, item or None for review)."""
    text = PREFIX.sub("", text)
    lengths = list(SLEEP_LENGTH.finditer(text))
    rest = SLEEP_LENGTH.sub(" ", text)
    tokens = [PARTICLE.sub("", token) for token in rest.replace(".", " ").split()]
    sleepy = [token for token in tokens if token in SLEEP_WORDS]
    if not sleepy:
        return None
    leftover = [t for t in tokens if t and t not in SLEEP_WORDS and t not in FILLER and t not in SLEEP_EXTRA]
    kinds = {word for word in sleepy if word in SLEEP_KINDS}
    # Feeding words, a volume, unknown words, two lengths or both kinds: a person decides.
    if FEEDING_TERMS.search(rest) or VOLUME.search(text) or leftover or len(lengths) > 1 or len(kinds) > 1 or not when:
        return True, None
    start = when.astimezone(SEOUL).replace(tzinfo=None)
    end = None
    if lengths:
        hours, minutes, only = lengths[0].groups()
        total = int(hours or 0) * 60 + int(minutes or 0) + int(only or 0)
        if not 0 < total <= 24 * 60:
            return True, None
        end = start + timedelta(minutes=total)
    elif not note:
        finish = parse_time((event.get("end") or {}).get("dateTime"))
        if finish and finish.tzinfo and finish > when:
            end = finish.astimezone(SEOUL).replace(tzinfo=None)
    item = {"id": item_id, "type": "sleep", "date": start.isoformat(timespec="minutes"),
            "end": end.isoformat(timespec="minutes") if end else "",
            "category": kinds.pop() if kinds else ("낮잠" if 7 <= start.hour < 19 else "밤잠"), "memo": note}
    if not any(word in SLEEP_KINDS for word in sleepy):
        item["confirm"] = "category"   # 수면/잠 alone: guessed from the time, the family confirms
    return True, item


def calendar_feeding(event, item_id, aliases=None):
    when, note = entry_time(event) if isinstance(event.get("summary", ""), str) else (None, "")
    if isinstance(event.get("summary"), str):
        slept = natural_sleep(" ".join(unicodedata.normalize("NFKC", event["summary"]).split()), event, item_id, when, note)
        if slept is not None:
            return slept
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


class WritebackRefused(ValueError):
    """A writeback request that must not be queued; the message is shown to the family."""


def content_fingerprint(summary, description, start):
    """Safeguard 1: what Somhouse wrote. An event whose content still matches is our own echo."""
    return hashlib.sha256(encode([summary or "", description or "", start or {}]).encode()).hexdigest()


def writeback_title(item):
    """A title the parser reads back to the same kind and amount (safeguard 2)."""
    kind = item.get("category") if item.get("category") in FEEDING_KINDS else "수유"
    return f"{kind} {item['amount']}"


def with_original(description, title):
    """Safeguard 6: keep what was said at the top of the description, once, and keep the user's text."""
    description = description or ""
    if description.startswith("음성 원문: "):
        return description
    line = f"음성 원문: {title}"
    return line + ("\n" + description if description else "")


MERGED_FIELDS = ("date", "end", "amount", "category", "memo")


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
        self.alarm, self.nap_alarm, self.stock_alarm = FeedingAlarm(self), NapAlarm(self), StockAlarm(self)

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
        written = (extensions.get("private") or {}).get("somhouseWrite")
        if (not cancelled and written and item
                and written == content_fingerprint(event.get("summary"), event.get("description"), event.get("start"))):
            # Safeguard 1: our own writeback coming back. Remember it as the Calendar side, change nothing else.
            with self.store.lock, self.store.connect() as db:
                db.execute("""UPDATE google_calendar_inputs SET fingerprint=?, applied=?, etag=?, review=0
                    WHERE binding=? AND inbox=? AND event_id=?""",
                           (encode([False, event.get("summary"), event.get("start")]), encode(item),
                            event.get("etag") or "", self.binding, self.inbox, event_id))
            return
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
                if previous and event.get("etag"):
                    db.execute("UPDATE google_calendar_inputs SET etag=? WHERE binding=? AND inbox=? AND event_id=?",
                               (event["etag"], *source_key))
                return
            applied = previous[1] if previous else None
            current = db.execute("SELECT body FROM items WHERE kind='records' AND id=?", (item_id,)).fetchone()
            current = current[0] if current else None
            if applied and current is None:
                # The family deleted this record in Somhouse. Deleting, cancelling or editing the original event
                # later must neither bring it back nor ask anything; just remember what Calendar now holds.
                db.execute("""UPDATE google_calendar_inputs SET fingerprint=?, review=0, etag=?
                    WHERE binding=? AND inbox=? AND event_id=?""", (fingerprint, event.get("etag") or "", *source_key))
                return
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
                        self.records.wake_from_sleep(db, item)
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
            db.execute("INSERT OR REPLACE INTO google_calendar_inputs (binding,inbox,event_id,item_id,fingerprint,applied,review,etag) VALUES (?,?,?,?,?,?,?,?)",
                       (*source_key, item_id, fingerprint, applied, review, event.get("etag") or ""))

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

    @property
    def can_write(self):
        return self.records.config.get("calendar_write") is True

    def writeback_check(self, db, item_id):
        """Everything that must hold before Somhouse may change the original event. Returns its details."""
        if not self.can_write:
            raise WritebackRefused("캘린더 쓰기 권한이 없어요. 관리자가 Google 계정을 다시 연결해야 해요.")
        row = db.execute("SELECT event_id,fingerprint FROM google_calendar_inputs WHERE binding=? AND inbox=? AND item_id=?",
                         (self.binding, self.inbox, item_id)).fetchone()
        current = db.execute("SELECT body FROM items WHERE kind='records' AND id=?", (item_id,)).fetchone()
        if row is None or current is None:
            raise WritebackRefused("캘린더에서 들어온 기록만 캘린더에 반영할 수 있어요.")
        item = json.loads(current[0])
        if item.get("type") != "feeding" or not item.get("amount"):
            raise WritebackRefused("수유 기록만 캘린더에 반영할 수 있어요.")
        source = db.execute("""SELECT raw FROM google_record_events WHERE binding=? AND source='calendar'
            AND item_id=? ORDER BY seq DESC LIMIT 1""", (self.binding, item_id)).fetchone()
        event = (json.loads(source[0]).get("event") or {}) if source else {}
        if not isinstance(event.get("start"), dict) or not event["start"].get("dateTime"):
            raise WritebackRefused("종일 일정은 캘린더에 반영하지 않아요.")
        title = writeback_title(item)
        # Safeguard 2: the new title must read back to this record, and must change something.
        probe = dict(event, summary=title, created=event.get("created"))
        _, reread = calendar_feeding(probe, item_id, load_aliases(db))
        if not reread or (reread["category"], reread["amount"]) != (
                item["category"] if item["category"] in FEEDING_KINDS else "기타", item["amount"]):
            raise WritebackRefused("이 기록은 캘린더 제목으로 정확히 옮길 수 없어요.")
        # The title Calendar has now (kept on every read, including our own echo).
        try:
            seen_title = json.loads(row[1])[1]
        except (TypeError, ValueError, IndexError):
            seen_title = event.get("summary")
        if seen_title == title:
            raise WritebackRefused("캘린더 일정이 이미 같은 내용이에요.")
        # Safeguard 5: a per-event limit stops any loop the other safeguards miss.
        recent = db.execute("SELECT COUNT(*) FROM google_calendar_writes WHERE binding=? AND event_id=? AND written_at>?",
                            (self.binding, row[0], time.time() - WRITE_WINDOW)).fetchone()[0]
        if recent >= WRITE_LIMIT:
            raise WritebackRefused("이 일정은 오늘 이미 여러 번 바꿨어요. 캘린더에서 직접 확인해 주세요.")
        return row[0], item, title

    def request_writeback(self, db, item_id):
        """Safeguard 3: only an explicit tap queues a writeback, once."""
        event_id, _, title = self.writeback_check(db, item_id)
        if db.execute("SELECT 1 FROM google_calendar_writebacks WHERE binding=? AND event_id=?",
                      (self.binding, event_id)).fetchone():
            raise WritebackRefused("이미 캘린더 반영을 요청했어요. 잠시만 기다려 주세요.")
        db.execute("INSERT OR REPLACE INTO google_calendar_writebacks VALUES (?,?,?,?)",
                   (self.binding, event_id, item_id, time.time()))
        return title

    def writeback_state(self, db, limit=200):
        """Which Calendar-input feedings would change if written back now, and which are waiting to be written.
        Only the most recent inputs are checked, so the every-poll status stays cheap."""
        if not self.can_write:
            return [], []
        pending = [row[0] for row in db.execute("SELECT item_id FROM google_calendar_writebacks WHERE binding=?",
                                                (self.binding,))]
        ready = []
        for (item_id,) in db.execute("""SELECT i.item_id FROM google_calendar_inputs i JOIN items r
                ON r.kind='records' AND r.id=i.item_id WHERE i.binding=? AND i.inbox=?
                AND json_extract(r.body,'$.type')='feeding' ORDER BY i.rowid DESC LIMIT ?""",
                                     (self.binding, self.inbox, limit)).fetchall():
            if item_id in pending:
                continue
            try:
                self.writeback_check(db, item_id)
            except WritebackRefused:
                continue
            ready.append(item_id)
        return ready, pending

    def flush_writebacks(self):
        with self.store.connect() as db:
            queued = db.execute("SELECT event_id,item_id FROM google_calendar_writebacks WHERE binding=? ORDER BY requested_at LIMIT 5",
                                (self.binding,)).fetchall()
        for event_id, item_id in queued:
            if self.records.stop.is_set():
                return
            self.writeback(event_id, item_id)

    def writeback(self, event_id, item_id):
        def finish(conflict=None):
            with self.store.lock, self.store.connect() as db:
                db.execute("DELETE FROM google_calendar_writebacks WHERE binding=? AND event_id=?", (self.binding, event_id))
                if conflict:
                    db.execute("UPDATE google_calendar_inputs SET review=1 WHERE binding=? AND inbox=? AND event_id=?",
                               (self.binding, self.inbox, event_id))
                    queue_event(db, self.binding, "records", item_id, {"event_id": event_id, "reason": conflict},
                                action="calendar-writeback", status="캘린더 반영 안 함 · " + conflict, skip_task=True)

        with self.store.connect() as db:
            try:
                _, item, title = self.writeback_check(db, item_id)
            except WritebackRefused as refused:
                finish(str(refused))
                return
            seen = db.execute("SELECT etag FROM google_calendar_inputs WHERE binding=? AND inbox=? AND event_id=?",
                              (self.binding, self.inbox, event_id)).fetchone()
        url = f"{calendar_url(self.inbox)}/{quote(event_id, safe='')}"
        try:
            remote = self.api.request(url, service="Calendar")
            # Safeguard 4: Calendar changed after Somhouse last read it; never overwrite that.
            if not seen or not seen[0] or remote.get("etag") != seen[0]:
                finish("캘린더 일정이 먼저 바뀌었어요")
                return
            description = with_original(remote.get("description"), remote.get("summary", ""))
            mark = content_fingerprint(title, description, remote.get("start"))
            body = {"summary": title, "description": description,
                    "extendedProperties": {"private": {"somhouseWrite": mark}}}
            result = self.api.request(url + "?sendUpdates=none", "PATCH", body, service="Calendar", etag=seen[0])
        except GoogleError as error:
            if error.status == 412:
                finish("캘린더 일정이 먼저 바뀌었어요")
                return
            if error.status in (403, 404, 410):
                finish(f"캘린더가 거절했어요 ({error.status})")
                return
            raise
        with self.store.lock, self.store.connect() as db:
            db.execute("INSERT INTO google_calendar_writes VALUES (?,?,?,?)", (self.binding, event_id, time.time(), mark))
            db.execute("DELETE FROM google_calendar_writebacks WHERE binding=? AND event_id=?", (self.binding, event_id))
            # Calendar now holds the new title: remember it right away (as the echo read would), so a second tap
            # before the next read is refused as "already the same" instead of writing again.
            db.execute("UPDATE google_calendar_inputs SET etag=?, fingerprint=? WHERE binding=? AND inbox=? AND event_id=?",
                       (result.get("etag") or "", encode([False, title, remote.get("start")]),
                        self.binding, self.inbox, event_id))
            # Safeguard 6: the Sheets history records the change next to the original input.
            queue_event(db, self.binding, "records", item_id,
                        {"event_id": event_id, "from": remote.get("summary", ""), "to": title},
                        action="calendar-writeback", title=title, status="캘린더 반영", skip_task=True)

    VIEW_BEFORE, VIEW_AFTER, VIEW_LIMIT = timedelta(days=40), timedelta(days=120), 1000

    def refresh_view(self):
        """Read-only copy of the family's primary-calendar events for the web dashboard.

        Feedings imported from Calendar are already records and are not shown twice. Nothing is
        written back to Google. The window is replaced as a whole so deleted events disappear.
        """
        now = datetime.now(timezone.utc)
        params = {"singleEvents": "true", "orderBy": "startTime", "maxResults": 250,
                  "timeMin": (now - self.VIEW_BEFORE).isoformat(timespec="seconds"),
                  "timeMax": (now + self.VIEW_AFTER).isoformat(timespec="seconds")}
        with self.store.connect() as db:
            imported = {row[0] for row in db.execute(
                "SELECT event_id FROM google_calendar_inputs WHERE binding=? AND inbox=?", (self.binding, self.inbox))}
        rows = []
        for event in event_pages(self.api, self.inbox, **params):
            if self.records.stop.is_set():
                return
            if (not isinstance(event, dict) or event.get("status") == "cancelled" or event.get("id") in imported
                    or event.get("recurringEventId") in imported
                    or ((event.get("extendedProperties") or {}).get("private") or {}).get("somhouseProjection") == "1"):
                continue
            start, end = event.get("start") or {}, event.get("end") or {}
            if start.get("dateTime"):
                begin, finish, all_day = parse_time(start["dateTime"]), parse_time(end.get("dateTime")), 0
                if not begin or begin.tzinfo is None:
                    continue
                begin = begin.astimezone(SEOUL).replace(tzinfo=None).isoformat(timespec="minutes")
                finish = (finish.astimezone(SEOUL).replace(tzinfo=None).isoformat(timespec="minutes")
                          if finish and finish.tzinfo else begin)
            elif isinstance(start.get("date"), str):
                # Google's all-day end date is exclusive; keep the last day the event covers.
                begin, all_day = start["date"], 1
                try:
                    finish = (datetime.fromisoformat(end.get("date", begin)) - timedelta(days=1)).date().isoformat()
                except ValueError:
                    finish = begin
                finish = max(finish, begin)
            else:
                continue
            link = event.get("htmlLink") if str(event.get("htmlLink", "")).startswith("https://www.google.com/calendar/") else ""
            rows.append((self.binding, event["id"], begin, finish, all_day, (event.get("summary") or "(제목 없음)")[:200], link))
            if len(rows) >= self.VIEW_LIMIT:
                break
        with self.store.lock, self.store.connect() as db:
            db.execute("DELETE FROM google_calendar_view WHERE binding=?", (self.binding,))
            db.executemany("INSERT OR REPLACE INTO google_calendar_view VALUES (?,?,?,?,?,?,?)", rows)

    def view_events(self, db):
        account = self.records.account_query().replace("?", "&")
        return [{"id": event_id, "date": start, "end": end, "allDay": bool(all_day), "title": title,
                 "link": link + account if link else ""}
                for event_id, start, end, all_day, title, link in db.execute(
                    """SELECT event_id,start,end,all_day,title,link FROM google_calendar_view WHERE binding=?
                       ORDER BY start LIMIT ?""", (self.binding, self.VIEW_LIMIT))]

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
