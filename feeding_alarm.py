"""Feeding alarm: the times of day the baby usually eats, and one Calendar reminder when a usual time passes
without a feeding.

The usual times come from the last 7 days of feedings (no AI). When a usual time plus a grace period goes by
with no feeding since an hour before it, the family's phones get a Calendar notification. One event in the
app's own feeding calendar is moved to the next alarm, so recording a feeding moves (or removes) it.
"""
from datetime import datetime, time, timedelta
import json
from math import atan2, ceil, cos, pi, sin
import secrets

from google_records import GoogleError, SEOUL

DAYS = 7                 # history used for the pattern
STEP = 10                # minutes between candidate times of day
HALF = 30                # a feeding within ±30 minutes counts for a time of day
SEPARATION = 90          # usual times at least 90 minutes apart
BEFORE = timedelta(minutes=60)   # a feeding from an hour before the usual time counts as that meal
GRACE = timedelta(minutes=30)    # the alarm goes off 30 minutes after the usual time
KEEP = timedelta(minutes=20)     # an alarm that just went off stays put for a while before moving on
SCHEMA = """
CREATE TABLE IF NOT EXISTS google_feeding_alarm (
    binding TEXT PRIMARY KEY, event_id TEXT NOT NULL, alarm_at TEXT NOT NULL, slot TEXT NOT NULL
);
"""


def local_now():
    return datetime.now(SEOUL).replace(tzinfo=None, second=0, microsecond=0)


def feeding_times(items):
    """Local start times of feedings, skipping entries without a valid date."""
    times = []
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "feeding":
            continue
        try:
            times.append(datetime.strptime(str(item.get("date", ""))[:16], "%Y-%m-%dT%H:%M"))
        except ValueError:
            continue
    return times


def gap(a, b):
    """Minutes between two times of day, around midnight."""
    d = abs(a - b) % 1440
    return min(d, 1440 - d)


def usual_times(feedings, now):
    """Times of day with a feeding on at least half the fed days (and at least 3) of the last 7 days."""
    since = now - timedelta(days=DAYS)
    points = [(t.hour * 60 + t.minute, t.date()) for t in feedings if since <= t <= now]
    fed_days = {day for _, day in points}
    if len(fed_days) < 3:
        return []
    need = max(3, ceil(len(fed_days) / 2))
    candidates = []
    for minute in range(0, 1440, STEP):
        near = [(m, day) for m, day in points if gap(m, minute) <= HALF]
        days = len({day for _, day in near})
        if days >= need:
            candidates.append((-days, -len(near), minute, near))
    chosen = []
    for neg_days, _, minute, near in sorted(candidates):
        # The center is the average time of the feedings around it (on a 24-hour circle), to 5 minutes.
        angle = atan2(sum(sin(m / 1440 * 2 * pi) for m, _ in near), sum(cos(m / 1440 * 2 * pi) for m, _ in near))
        center = round((angle / (2 * pi) * 1440) % 1440 / 5) * 5 % 1440
        if all(gap(center, other["minute"]) >= SEPARATION for other in chosen):
            chosen.append({"minute": center, "time": f"{center // 60:02d}:{center % 60:02d}", "days": -neg_days})
    return sorted(chosen, key=lambda slot: slot["minute"])


def next_alarm(feedings, now, slots):
    """The next usual time still waiting for a feeding, as (alarm time, slot), or (None, None)."""
    past = [t for t in feedings if t <= now]
    options = []
    for offset in (-1, 0, 1):
        midnight = datetime.combine(now.date() + timedelta(days=offset), time())
        for slot in slots:
            usual = midnight + timedelta(minutes=slot["minute"])
            options.append((usual + GRACE, usual, slot))
    for alarm, usual, slot in sorted(options, key=lambda option: option[0]):
        if alarm <= now - KEEP:
            continue
        if any(t >= usual - BEFORE for t in past):
            continue
        return alarm, slot
    return None, None


class FeedingAlarm:
    """Keeps at most one alarm event in the feeding calendar, for families who turned the alarm on."""

    def __init__(self, calendar):
        self.calendar, self.store, self.binding = calendar, calendar.store, calendar.binding

    def plan(self, db, now=None):
        now = now or local_now()
        setting = db.execute("SELECT value FROM family_settings WHERE key='feeding_alarm'").fetchone()
        enabled = bool(setting and (json.loads(setting[0]) or {}).get("enabled"))
        feedings = feeding_times(json.loads(row[0]) for row in db.execute("SELECT body FROM items WHERE kind='records'"))
        slots = usual_times(feedings, now)
        alarm, slot = next_alarm(feedings, now, slots) if enabled else (None, None)
        return enabled, slots, alarm, slot

    def status(self, db):
        enabled, slots, alarm, slot = self.plan(db)
        return {"enabled": enabled, "slots": [{"time": s["time"], "days": s["days"]} for s in slots],
                "next": alarm.isoformat(timespec="minutes") if alarm else None,
                "usual": slot["time"] if slot else None}

    def sync(self):
        with self.store.connect() as db:
            _, _, alarm, slot = self.plan(db)
            row = db.execute("SELECT event_id,alarm_at,slot FROM google_feeding_alarm WHERE binding=?",
                             (self.binding,)).fetchone()
        wanted = (alarm.isoformat(timespec="minutes"), slot["time"]) if alarm else None
        if row and wanted == (row[1], row[2]):
            return
        if wanted is None:
            if row:
                self.calendar.remove_event(row[0])
                with self.store.lock, self.store.connect() as db:
                    db.execute("DELETE FROM google_feeding_alarm WHERE binding=? AND event_id=?", (self.binding, row[0]))
            return
        event_id = row[0] if row else secrets.token_hex(20)
        if not row:
            # Saved first, so a crash after creating the event cannot leave an untracked one behind.
            with self.store.lock, self.store.connect() as db:
                db.execute("INSERT OR REPLACE INTO google_feeding_alarm VALUES (?,?,?,?)", (self.binding, event_id, "", ""))
        event_id = self.write(event_id, alarm, slot, new=row is None)
        with self.store.lock, self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO google_feeding_alarm VALUES (?,?,?,?)",
                       (self.binding, event_id, wanted[0], wanted[1]))

    def write(self, event_id, alarm, slot, *, new):
        start = alarm.replace(tzinfo=SEOUL)
        payload = {
            "summary": f"🍼 아기 밥 시간이 지났어요 (평소 {slot['time']})",
            "description": (f"최근 7일 중 {slot['days']}일은 {slot['time']}쯤 수유했는데, "
                            f"{(alarm - GRACE - BEFORE).strftime('%H:%M')} 이후 수유 기록이 없어요.\n"
                            "수유를 기록하면 이 알림은 다음 수유 시간대로 옮겨져요. 솜하우스 통계 화면에서 끌 수 있어요."),
            "start": {"dateTime": start.isoformat(), "timeZone": "Asia/Seoul"},
            "end": {"dateTime": (start + timedelta(minutes=5)).isoformat(), "timeZone": "Asia/Seoul"},
            "transparency": "transparent",
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
            "extendedProperties": {"private": {"somhouseProjection": "1", "somhouseAlarm": "1"}},
        }
        url = self.calendar_url()
        if not new:
            try:
                self.calendar.api.request(f"{url}/{event_id}?sendUpdates=none", "PATCH", payload, "Calendar")
                return event_id
            except GoogleError as error:
                if error.status not in (404, 410):
                    raise
            # Deleted in Calendar by hand: a deleted event can keep its ID, so make a new one.
            event_id = secrets.token_hex(20)
        self.calendar.api.request(url + "?sendUpdates=none", "POST", {**payload, "id": event_id}, "Calendar")
        return event_id

    def calendar_url(self):
        from calendar_records import calendar_url
        return calendar_url(self.calendar.outbox)


def setting_value(enabled, username, now=None):
    return {"enabled": True, "by": username, "at": (now or local_now()).isoformat(timespec="minutes")} if enabled else None

