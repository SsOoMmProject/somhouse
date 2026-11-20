"""Feeding and nap alarms. Feeding: the times of day the baby usually eats, and one Calendar reminder when a usual time passes
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
CREATE TABLE IF NOT EXISTS google_nap_alarm (
    binding TEXT PRIMARY KEY, event_id TEXT NOT NULL, alarm_at TEXT NOT NULL, slot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_stock_alarm (
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


def stock_setting(db):
    row = db.execute("SELECT value FROM family_settings WHERE key='diaper_stock'").fetchone()
    return json.loads(row[0]) if row else None

def records_of(db):
    return [json.loads(row[0]) for row in db.execute("SELECT body FROM items WHERE kind='records'")]


def setting_on(db, key):
    row = db.execute("SELECT value FROM family_settings WHERE key=?", (key,)).fetchone()
    return bool(row and (json.loads(row[0]) or {}).get("enabled"))


class CalendarAlarm:
    """Keeps at most one alarm event in the app's feeding calendar, moved to the next alarm time.

    A subclass names its table and setting, plans the next alarm and writes the event's words.
    """
    TABLE = SETTING = ""

    def __init__(self, calendar):
        self.calendar, self.store, self.binding = calendar, calendar.store, calendar.binding

    def plan(self, db, now=None):
        raise NotImplementedError

    def words(self, plan):
        raise NotImplementedError

    def sync(self):
        with self.store.connect() as db:
            plan = self.plan(db)
            row = db.execute(f"SELECT event_id,alarm_at,slot FROM {self.TABLE} WHERE binding=?", (self.binding,)).fetchone()
        alarm = plan.get("alarm")
        wanted = (alarm.isoformat(timespec="minutes"), plan["key"]) if alarm else None
        if row and wanted == (row[1], row[2]):
            return
        if wanted is None:
            if row:
                self.calendar.remove_event(row[0])
                with self.store.lock, self.store.connect() as db:
                    db.execute(f"DELETE FROM {self.TABLE} WHERE binding=? AND event_id=?", (self.binding, row[0]))
            return
        event_id = row[0] if row else secrets.token_hex(20)
        if not row:
            # Saved first, so a crash after creating the event cannot leave an untracked one behind.
            with self.store.lock, self.store.connect() as db:
                db.execute(f"INSERT OR REPLACE INTO {self.TABLE} VALUES (?,?,?,?)", (self.binding, event_id, "", ""))
        event_id = self.write(event_id, alarm, *self.words(plan), new=row is None)
        with self.store.lock, self.store.connect() as db:
            db.execute(f"INSERT OR REPLACE INTO {self.TABLE} VALUES (?,?,?,?)", (self.binding, event_id, *wanted))

    def write(self, event_id, alarm, summary, description, *, new):
        start = alarm.replace(tzinfo=SEOUL)
        payload = {
            "summary": summary, "description": description,
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


class FeedingAlarm(CalendarAlarm):
    """When a usual feeding time passes without a feeding."""
    TABLE, SETTING = "google_feeding_alarm", "feeding_alarm"

    def plan(self, db, now=None):
        now = now or local_now()
        enabled = setting_on(db, self.SETTING)
        feedings = feeding_times(records_of(db))
        slots = usual_times(feedings, now)
        alarm, slot = next_alarm(feedings, now, slots) if enabled else (None, None)
        return {"enabled": enabled, "slots": slots, "alarm": alarm, "slot": slot, "key": slot["time"] if slot else ""}

    def words(self, plan):
        slot, alarm = plan["slot"], plan["alarm"]
        return (f"🍼 아기 밥 시간이 지났어요 (평소 {slot['time']})",
                f"최근 7일 중 {slot['days']}일은 {slot['time']}쯤 수유했는데, "
                f"{(alarm - GRACE - BEFORE).strftime('%H:%M')} 이후 수유 기록이 없어요.\n"
                "수유를 기록하면 이 알림은 다음 수유 시간대로 옮겨져요. 솜하우스 통계 화면에서 끌 수 있어요.")

    def status(self, db):
        plan = self.plan(db)
        return {"enabled": plan["enabled"], "slots": [{"time": s["time"], "days": s["days"]} for s in plan["slots"]],
                "next": plan["alarm"].isoformat(timespec="minutes") if plan["alarm"] else None,
                "usual": plan["slot"]["time"] if plan["slot"] else None}


# Wake windows: how long the baby stays awake in the daytime before sleeping again.
DAY_START, DAY_END = 7, 20       # daytime hours: wake-ups counted, and alarms allowed until DAY_END + 1
WAKE_MIN, WAKE_MAX = 20, 6 * 60  # a wake window outside 20 minutes ~ 6 hours is a missing record
WAKE_SAMPLES = 5


def sleeps_of(items):
    out = []
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "sleep":
            continue
        try:
            start = datetime.strptime(str(item.get("date", ""))[:16], "%Y-%m-%dT%H:%M")
            end = datetime.strptime(str(item["end"])[:16], "%Y-%m-%dT%H:%M") if item.get("end") else None
        except ValueError:
            continue
        out.append((start, end))
    return sorted(out)


def wake_windows(sleeps, now):
    """Minutes from a daytime wake-up to the next sleep, over the last 7 days."""
    since, windows = now - timedelta(days=DAYS), []
    for (_, woke), (slept, _) in zip(sleeps, sleeps[1:]):
        if woke and since <= woke < slept <= now and DAY_START <= woke.hour < DAY_END:
            minutes = (slept - woke).total_seconds() / 60
            if WAKE_MIN <= minutes <= WAKE_MAX:
                windows.append(minutes)
    return windows


def usual_wake(windows):
    """The median wake window to 5 minutes, once there are enough of them."""
    if len(windows) < WAKE_SAMPLES:
        return None
    ordered = sorted(windows)
    middle = len(ordered) // 2
    median = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    return int(round(median / 5) * 5)


def next_nap(sleeps, now, usual):
    """When the baby has been awake for the usual time in the daytime, as (alarm, woke), or (None, None)."""
    past = [(start, end) for start, end in sleeps if start <= now]
    if not usual or not past:
        return None, None
    start, end = past[-1]
    if end is None or end > now:
        return None, None  # asleep (or the last sleep has no wake time yet)
    alarm = end + timedelta(minutes=usual)
    if not DAY_START <= end.hour < DAY_END or alarm.hour >= DAY_END + 1 or alarm.date() != end.date() or alarm <= now - KEEP:
        return None, None
    return alarm, end


class NapAlarm(CalendarAlarm):
    """When the baby has been awake longer than usual in the daytime."""
    TABLE, SETTING = "google_nap_alarm", "nap_alarm"

    def plan(self, db, now=None):
        now = now or local_now()
        enabled = setting_on(db, self.SETTING)
        sleeps = sleeps_of(records_of(db))
        windows = wake_windows(sleeps, now)
        usual = usual_wake(windows)
        alarm, woke = next_nap(sleeps, now, usual) if enabled else (None, None)
        return {"enabled": enabled, "usual": usual, "samples": len(windows), "alarm": alarm, "woke": woke,
                "key": woke.isoformat(timespec="minutes") if woke else ""}

    def words(self, plan):
        usual, woke = plan["usual"], plan["woke"]
        length = f"{usual // 60}시간 {usual % 60}분" if usual >= 60 else f"{usual}분"
        return (f"😴 낮잠 시간이에요 (깬 지 {length})",
                f"최근 7일 낮에는 깬 뒤 보통 {length} 지나 다시 잠들었어요. {woke.strftime('%H:%M')}에 깬 뒤 수면 기록이 없어요.\n"
                "수면을 기록하면 이 알림은 사라져요. 솜하우스 통계 화면에서 끌 수 있어요.")

    def status(self, db):
        plan = self.plan(db)
        return {"enabled": plan["enabled"], "usual_minutes": plan["usual"], "samples": plan["samples"],
                "next": plan["alarm"].isoformat(timespec="minutes") if plan["alarm"] else None}


# Diaper stock: the count the family entered minus every diaper change recorded since, used up at the average
# daily rate of the last 7 days (days with diaper records only, at least 3 of them).
STOCK_ITEM = "기저귀"
STOCK_HOUR = 10          # the buying reminder goes off at 10:00 on its day
STOCK_MIN_DAYS = 3


def stamp(value):
    try:
        return datetime.strptime(str(value)[:16], "%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def stock_plan(setting, items, now):
    """Diapers left, the daily use, the day they run out and when to remind about buying, or None if not set up."""
    if not isinstance(setting, dict) or not isinstance(setting.get("count"), int) or stamp(setting.get("at")) is None:
        return None
    since, counted = stamp(setting["at"]), now - timedelta(days=DAYS)
    changes = [t for t in (stamp(x.get("date")) for x in items if isinstance(x, dict) and x.get("type") == "diaper") if t]
    left = max(0, setting["count"] - sum(1 for t in changes if since < t <= now))
    recent = [t for t in changes if counted < t <= now]
    days = {t.date() for t in recent}
    daily = round(len(recent) / len(days), 1) if len(days) >= STOCK_MIN_DAYS else None
    plan = {"left": left, "daily": daily, "runout": None, "alarm": None}
    if daily:
        runout = now + timedelta(days=left / daily)
        alert = datetime.combine((runout - timedelta(days=setting.get("alertDays", 3))).date(), time(STOCK_HOUR))
        # Already due when it is set up (few left): remind a few minutes after the stock was entered.
        plan.update(runout=runout, alarm=max(alert, since + timedelta(minutes=5)))
    return plan


def setting_value(enabled, username, now=None):
    return {"enabled": True, "by": username, "at": (now or local_now()).isoformat(timespec="minutes")} if enabled else None


class StockAlarm(CalendarAlarm):
    """A reminder to buy diapers a few days before they run out; on that day 기저귀 also joins the shopping list."""
    TABLE, SETTING = "google_stock_alarm", "diaper_stock"

    def plan(self, db, now=None):
        now = now or local_now()
        setting = stock_setting(db)
        plan = stock_plan(setting, records_of(db), now) or {"left": None, "daily": None, "runout": None, "alarm": None}
        plan.update(setting=setting, now=now, key=f"{(setting or {}).get('at', '')}|{plan['alarm'].isoformat() if plan['alarm'] else ''}")
        return plan

    def words(self, plan):
        days = plan["left"] / plan["daily"]
        return (f"🧷 기저귀 살 때예요 (약 {plan['left']}개 · {days:.0f}일분)",
                f"하루 평균 {plan['daily']}개를 써서 {plan['runout'].strftime('%m/%d')}쯤 다 써요. 솜하우스 구매 목록에 기저귀를 넣어 둘게요.\n"
                "산 뒤 구매 목록에서 ‘✓ 샀어요’를 누르고 산 팩 수를 입력하면 재고에 더해져요.")

    def sync(self):
        super().sync()
        with self.store.connect() as db:
            plan = self.plan(db)
        setting, alarm = plan["setting"], plan["alarm"]
        if not alarm or plan["now"] < alarm or setting.get("listed") == plan["key"]:
            return
        with self.store.lock, self.store.connect() as db:
            pending = any(item.get("done") != "yes" and STOCK_ITEM in str(item.get("title", ""))
                          for item in (json.loads(row[0]) for row in db.execute("SELECT body FROM items WHERE kind='shopping'")))
            if not pending:
                item = {"id": "stock-" + secrets.token_hex(8), "title": STOCK_ITEM, "quantity": "1팩", "done": "no",
                        "memo": f"솜하우스 재고 알림 · 남은 기저귀 약 {plan['left']}개"}
                db.execute("INSERT INTO items VALUES ('shopping',?,?)", (item["id"], json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))))
                self.calendar.records.queue(db, "shopping", item["id"], item, "save")
            db.execute("UPDATE family_settings SET value=? WHERE key='diaper_stock'",
                       (json.dumps({**setting, "listed": plan["key"]}, ensure_ascii=False, sort_keys=True, separators=(",", ":")),))

    def status(self, db):
        plan = self.plan(db)
        return {"left": plan["left"], "daily": plan["daily"],
                "runout": plan["runout"].isoformat(timespec="minutes") if plan["runout"] else None,
                "next": plan["alarm"].isoformat(timespec="minutes") if plan["alarm"] else None}
