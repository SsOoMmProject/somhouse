"""Feeding alarm: usual feeding times from the last 7 days and the single Calendar reminder that follows them."""
from datetime import datetime, timedelta
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from feeding_alarm import FeedingAlarm, diaper_source, feeding_times, stock_plan, next_alarm, next_nap, sleeps_of, usual_times, usual_wake, wake_windows
from google_records import GoogleError, GoogleRecords, encode
from server import Store

NOW = datetime(2026, 11, 21, 12, 0)


def week(times, days=range(1, 8), drift=3):
    """Feedings at the given times on each past day, drifting a few minutes from day to day."""
    return [(NOW - timedelta(days=d)).replace(hour=h, minute=0) + timedelta(minutes=m + (d % 3) * drift)
            for d in days for h, m in times]


class UsualTimes(unittest.TestCase):
    def test_finds_times_eaten_on_most_days(self):
        slots = usual_times(week([(3, 10), (6, 40), (10, 5), (13, 30)]), NOW)
        # The last 7 days are the last 168 hours: the mornings of 7 days ago (before noon) are already out.
        self.assertEqual([(s["time"], s["days"]) for s in slots], [("03:15", 6), ("06:45", 6), ("10:10", 6), ("13:35", 7)])

    def test_needs_three_fed_days_and_half_of_them(self):
        self.assertEqual(usual_times(week([(9, 0)], days=(1, 2)), NOW), [])
        # 9:00 on 3 of 7 fed days is not a habit; 13:00 on all 7 is.
        feeds = week([(13, 0)]) + week([(9, 0)], days=(1, 2, 3))
        self.assertEqual([s["time"] for s in usual_times(feeds, NOW)], ["13:05"])
        # Older than 7 days does not count.
        self.assertEqual(usual_times(week([(9, 0)], days=range(8, 15)), NOW), [])

    def test_a_time_around_midnight_is_one_slot(self):
        feeds = [(NOW - timedelta(days=d)).replace(hour=23, minute=50) + timedelta(minutes=(d % 3) * 10) for d in range(1, 8)]
        self.assertEqual([s["time"] for s in usual_times(feeds, NOW)], ["00:00"])

    def test_feeding_times_skip_other_records_and_bad_dates(self):
        items = [{"type": "feeding", "date": "2026-11-20T08:00"}, {"type": "sleep", "date": "2026-11-20T09:00"},
                 {"type": "feeding", "date": "어제"}, "junk"]
        self.assertEqual(feeding_times(items), [datetime(2026, 11, 20, 8, 0)])


class NextAlarm(unittest.TestCase):
    slots = [{"minute": 10 * 60, "time": "10:00", "days": 7}, {"minute": 14 * 60, "time": "14:00", "days": 6}]

    def test_alarm_half_an_hour_after_an_uneaten_usual_time(self):
        # 10:00 was eaten at 9:20 (within the hour before), so the next one is 14:00 + 30 minutes.
        alarm, slot = next_alarm([NOW.replace(hour=9, minute=20)], NOW, self.slots)
        self.assertEqual((alarm, slot["time"]), (NOW.replace(hour=14, minute=30), "14:00"))
        # Not eaten since 8:30: the 10:30 alarm has gone off; it waits 20 minutes then moves to 14:30.
        self.assertEqual(next_alarm([NOW.replace(hour=8, minute=30)], NOW.replace(hour=10, minute=45), self.slots)[0],
                         NOW.replace(hour=10, minute=30))
        self.assertEqual(next_alarm([NOW.replace(hour=8, minute=30)], NOW.replace(hour=10, minute=51), self.slots)[0],
                         NOW.replace(hour=14, minute=30))

    def test_after_the_last_time_today_comes_tomorrow(self):
        late = NOW.replace(hour=20)
        self.assertEqual(next_alarm([late.replace(hour=15)], late, self.slots)[0], (late + timedelta(days=1)).replace(hour=10, minute=30))
        self.assertEqual(next_alarm([], NOW, []), (None, None))


class CalendarAlarm(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        config = {"binding": "test", "inbox": "@default", "task_list": "archive", "spreadsheet": "sheet",
                  "calendar_inbox": "primary", "calendar_outbox": "feeding", "refresh_token": "fake"}
        self.bridge = GoogleRecords(self.store, config)
        self.alarm = self.bridge.calendar.alarm
        self.calls = []
        with self.store.connect() as db:
            for i, when in enumerate(week([(10, 0), (14, 0)])):
                item = {"id": f"f{i}", "type": "feeding", "date": when.isoformat(timespec="minutes"), "category": "분유", "amount": "120ml"}
                db.execute("INSERT INTO items VALUES ('records',?,?)", (item["id"], encode(item)))

    def api(self, url, method="GET", body=None, service=None):
        self.calls.append((method, url.split("?")[0].rsplit("/", 1)[-1], body))
        return {}

    def sync(self, now):
        with patch("feeding_alarm.local_now", return_value=now), patch.object(self.bridge.api, "request", side_effect=self.api):
            self.alarm.sync()

    def turn(self, enabled):
        with self.store.connect() as db:
            self.store.put_setting(db, "feeding_alarm", {"enabled": True} if enabled else None)

    def feed(self, when):
        with self.store.connect() as db:
            item = {"id": "now", "type": "feeding", "date": when.isoformat(timespec="minutes"), "category": "분유", "amount": "90ml"}
            db.execute("INSERT OR REPLACE INTO items VALUES ('records','now',?)", (encode(item),))

    def test_off_by_default_then_one_event_follows_the_next_uneaten_time(self):
        self.sync(NOW)
        self.assertEqual(self.calls, [])
        with patch("feeding_alarm.local_now", return_value=NOW), self.store.connect() as db:
            status = self.alarm.status(db)
        self.assertEqual(status, {"enabled": False, "slots": [{"time": "10:05", "days": 6}, {"time": "14:05", "days": 7}],
                                  "next": None, "usual": None})
        self.turn(True)
        self.sync(NOW)
        method, target, body = self.calls[0]
        self.assertEqual((method, target), ("POST", "events"))
        self.assertEqual(body["start"]["dateTime"], "2026-11-21T14:35:00+09:00")
        self.assertEqual(body["reminders"], {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]})
        self.assertEqual(body["summary"], "🍼 아기 밥 시간이 지났어요 (평소 14:05)")
        self.assertIn("최근 7일 중 7일은 14:05쯤", body["description"])
        event_id = body["id"]
        # Nothing changes, nothing is sent.
        self.sync(NOW.replace(minute=5))
        self.assertEqual(len(self.calls), 1)
        # A feeding at 13:50 covers 14:05; the same event moves to tomorrow's 10:05.
        self.feed(NOW.replace(hour=13, minute=50))
        self.sync(NOW.replace(hour=13, minute=55))
        self.assertEqual(self.calls[1][:2], ("PATCH", event_id))
        self.assertEqual(self.calls[1][2]["start"]["dateTime"], "2026-11-22T10:35:00+09:00")
        with patch("feeding_alarm.local_now", return_value=NOW.replace(hour=13, minute=55)), self.store.connect() as db:
            self.assertEqual({k: v for k, v in self.alarm.status(db).items() if k != "slots"},
                             {"enabled": True, "next": "2026-11-22T10:35", "usual": "10:05"})
        # Turning it off removes the event.
        self.turn(False)
        self.sync(NOW.replace(hour=14))
        self.assertEqual(self.calls[2][:2], ("DELETE", event_id))
        with self.store.connect() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM google_feeding_alarm").fetchone())

    def test_an_event_deleted_by_hand_is_made_again_with_a_new_id(self):
        self.turn(True)
        self.sync(NOW)
        first = self.calls[0][2]["id"]
        self.feed(NOW.replace(hour=13, minute=50))
        def gone(url, method="GET", body=None, service=None):
            self.calls.append((method, url.split("?")[0].rsplit("/", 1)[-1], body))
            if method == "PATCH":
                raise GoogleError(404, "Calendar")
            return {}
        with patch("feeding_alarm.local_now", return_value=NOW.replace(hour=13, minute=55)), \
                patch.object(self.bridge.api, "request", side_effect=gone):
            self.alarm.sync()
        self.assertEqual([c[0] for c in self.calls], ["POST", "PATCH", "POST"])
        self.assertNotEqual(self.calls[2][2]["id"], first)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT event_id,alarm_at FROM google_feeding_alarm").fetchone(),
                             (self.calls[2][2]["id"], "2026-11-22T10:35"))

    def test_a_failed_first_send_is_retried_without_a_second_event(self):
        self.turn(True)
        with patch("feeding_alarm.local_now", return_value=NOW), \
                patch.object(self.bridge.api, "request", side_effect=GoogleError(500, "Calendar")):
            with self.assertRaises(GoogleError):
                self.alarm.sync()
        with self.store.connect() as db:
            reserved = db.execute("SELECT event_id,alarm_at FROM google_feeding_alarm").fetchone()
        self.assertEqual(reserved[1], "")
        # The retry tries the reserved ID first, then creates it.
        def missing(url, method="GET", body=None, service=None):
            self.calls.append((method, url.split("?")[0].rsplit("/", 1)[-1], body))
            if method == "PATCH":
                raise GoogleError(404, "Calendar")
            return {}
        with patch("feeding_alarm.local_now", return_value=NOW), patch.object(self.bridge.api, "request", side_effect=missing):
            self.alarm.sync()
        self.assertEqual([c[0] for c in self.calls], ["PATCH", "POST"])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM google_feeding_alarm").fetchone()[0], 1)

    def test_status_reaches_the_web(self):
        self.turn(True)
        with patch("feeding_alarm.local_now", return_value=NOW), self.store.connect() as db:
            status = self.bridge.status(db)
            settings = self.store.settings(db)
        self.assertEqual(status["feeding_alarm"]["next"], "2026-11-21T14:35")
        self.assertTrue(settings["feedingAlarm"])
        self.assertEqual(json.loads(json.dumps(status))["feeding_alarm"]["usual"], "14:05")



def naps(days=range(1, 8), awake=110):
    """Each day: night sleep until 07:00, a nap after `awake` minutes (1 hour long), then another after `awake` again."""
    items = []
    for d in days:
        day = (NOW - timedelta(days=d)).replace(hour=0, minute=0)
        first = day.replace(hour=7) + timedelta(minutes=awake)
        second = first + timedelta(minutes=60 + awake)
        items += [{"type": "sleep", "date": (day - timedelta(hours=3)).isoformat(timespec="minutes"), "end": day.replace(hour=7).isoformat(timespec="minutes")},
                  {"type": "sleep", "date": first.isoformat(timespec="minutes"), "end": (first + timedelta(minutes=60)).isoformat(timespec="minutes")},
                  {"type": "sleep", "date": second.isoformat(timespec="minutes"), "end": (second + timedelta(minutes=60)).isoformat(timespec="minutes")}]
    return items


class NapTiming(unittest.TestCase):
    def test_usual_daytime_wake_window(self):
        windows = wake_windows(sleeps_of(naps()), NOW)
        self.assertEqual(set(windows), {110.0})
        self.assertEqual(usual_wake(windows), 110)
        self.assertIsNone(usual_wake([100, 120, 90, 80]))  # fewer than 5
        self.assertEqual(usual_wake([60, 70, 80, 90, 500, 100]), 85)
        # A wake-up at night or a gap over 6 hours (a missing record) does not count.
        night = sleeps_of([{"type": "sleep", "date": "2026-11-20T01:00", "end": "2026-11-20T02:00"},
                           {"type": "sleep", "date": "2026-11-20T03:00", "end": "2026-11-20T08:00"},
                           {"type": "sleep", "date": "2026-11-20T15:00", "end": "2026-11-20T16:00"}])
        self.assertEqual(wake_windows(night, NOW), [])

    def test_alarm_after_the_usual_time_awake_in_the_daytime(self):
        woke = NOW.replace(hour=11, minute=0)
        sleeps = [(woke - timedelta(hours=1), woke)]
        self.assertEqual(next_nap(sleeps, NOW, 110), (woke + timedelta(minutes=110), woke))
        # Asleep now, no usual time yet, or woke in the evening: no alarm.
        self.assertEqual(next_nap([(NOW.replace(hour=11), None)], NOW, 110), (None, None))
        self.assertEqual(next_nap(sleeps, NOW, None), (None, None))
        evening = NOW.replace(hour=20, minute=30)
        self.assertEqual(next_nap([(evening - timedelta(hours=1), evening)], evening, 60), (None, None))
        # Gone off over 20 minutes ago: dropped.
        self.assertEqual(next_nap(sleeps, woke + timedelta(minutes=140), 110), (None, None))


class CalendarNapAlarm(unittest.TestCase):
    """The nap alarm uses its own event, next to the feeding alarm's."""
    setUp, api = CalendarAlarm.setUp, CalendarAlarm.api

    def test_nap_alarm_follows_the_last_wake_up(self):
        with self.store.connect() as db:
            for i, item in enumerate(naps() + [{"type": "sleep", "date": "2026-11-21T09:00", "end": "2026-11-21T11:00"}]):
                db.execute("INSERT INTO items VALUES ('records',?,?)", (f"s{i}", encode({"id": f"s{i}", "category": "낮잠", **item})))
            self.store.put_setting(db, "nap_alarm", {"enabled": True})
            with patch("feeding_alarm.local_now", return_value=NOW):
                self.assertEqual(self.bridge.status(db)["nap_alarm"],
                                 {"enabled": True, "usual_minutes": 110, "samples": 12, "next": "2026-11-21T12:50"})
        with patch("feeding_alarm.local_now", return_value=NOW), patch.object(self.bridge.api, "request", side_effect=self.api):
            self.bridge.calendar.nap_alarm.sync()
        method, _, body = self.calls[0]
        self.assertEqual((method, body["start"]["dateTime"]), ("POST", "2026-11-21T12:50:00+09:00"))
        self.assertEqual(body["summary"], "😴 낮잠 시간이에요 (깬 지 1시간 50분)")
        self.assertIn("11:00에 깬 뒤 수면 기록이 없어요", body["description"])
        # Falling asleep removes it; the feeding alarm's table is untouched.
        with self.store.connect() as db:
            db.execute("INSERT INTO items VALUES ('records','nap',?)",
                       (encode({"id": "nap", "type": "sleep", "date": "2026-11-21T12:30", "end": "", "category": "낮잠"}),))
        with patch("feeding_alarm.local_now", return_value=NOW.replace(hour=12, minute=35)), \
                patch.object(self.bridge.api, "request", side_effect=self.api):
            self.bridge.calendar.nap_alarm.sync()
        self.assertEqual(self.calls[1][:2], ("DELETE", body["id"]))
        with self.store.connect() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM google_nap_alarm").fetchone())
            self.assertIsNone(db.execute("SELECT 1 FROM google_feeding_alarm").fetchone())



def diapers(per_day, days=range(1, 8), start=8):
    return [{"type": "diaper", "date": (NOW - timedelta(days=d)).replace(hour=start + i).isoformat(timespec="minutes"), "category": "소변"}
            for d in days for i in range(per_day)]


class DiaperStock(unittest.TestCase):
    setting = {"perPack": 60, "count": 100, "at": "2026-11-19T00:00", "alertDays": 3}

    def test_left_daily_use_and_reminder(self):
        plan = stock_plan(self.setting, diapers(8, days=range(1, 7)), NOW)
        # 8 changes on each of 11/19 and 11/20 after the count was set → 84 left; 8 a day → 10.5 days.
        self.assertEqual((plan["left"], plan["daily"]), (84, 8.0))
        self.assertEqual(plan["runout"], NOW + timedelta(days=10.5))
        self.assertEqual(plan["alarm"], datetime(2026, 11, 29, 10, 0))  # runs out 12/2 00:00
        # A partial day at the edge of the 7 days counts as a day with records.
        self.assertEqual(stock_plan(self.setting, diapers(8), NOW)["daily"], 7.3)
        self.assertIsNone(stock_plan(None, [], NOW))
        self.assertIsNone(stock_plan({"count": "x", "at": "2026-11-18T12:00"}, [], NOW))

    def test_needs_three_days_and_reminds_soon_when_already_low(self):
        plan = stock_plan(self.setting, diapers(8, days=(1, 2)), NOW)
        self.assertEqual((plan["left"], plan["daily"], plan["alarm"]), (84, None, None))
        low = stock_plan({**self.setting, "count": 10, "at": "2026-11-21T11:00"}, diapers(8, days=range(1, 7)), NOW)
        self.assertEqual((low["left"], low["alarm"]), (10, datetime(2026, 11, 21, 11, 5)))


class CalendarStock(unittest.TestCase):
    setUp, api = CalendarAlarm.setUp, CalendarAlarm.api

    def stock(self, count, at="2026-11-21T11:58"):
        with self.store.connect() as db:
            for i, item in enumerate(diapers(8, days=range(1, 7))):
                db.execute("INSERT OR REPLACE INTO items VALUES ('records',?,?)", (f"d{i}", encode({"id": f"d{i}", **item})))
            self.store.put_setting(db, "diaper_stock", {"perPack": 60, "count": count, "at": at, "alertDays": 3, "listed": ""})

    def sync(self, now):
        with patch("feeding_alarm.local_now", return_value=now), patch.object(self.bridge.api, "request", side_effect=self.api):
            self.bridge.calendar.stock_alarm.sync()

    def shopping(self):
        with self.store.connect() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT body FROM items WHERE kind='shopping'")]

    def test_reminder_event_then_diapers_join_the_shopping_list_once(self):
        self.stock(10)
        self.sync(NOW)
        method, _, body = self.calls[0]
        self.assertEqual((method, body["start"]["dateTime"]), ("POST", "2026-11-21T12:03:00+09:00"))
        self.assertEqual(body["summary"], "🧷 기저귀 살 때예요 (약 10개 · 1일분)")
        self.assertEqual(self.shopping(), [])
        with patch("feeding_alarm.local_now", return_value=NOW), self.store.connect() as db:
            self.assertEqual(self.bridge.status(db)["diaper_stock"],
                             {"left": 10, "daily": 8.0, "runout": "2026-11-22T18:00", "next": "2026-11-21T12:03"})
        # At the reminder time 기저귀 is added and sent to Google like any shopping item; only once.
        self.sync(NOW.replace(minute=4))
        added = self.shopping()
        self.assertEqual([(x["title"], x["quantity"], x["done"]) for x in added], [("기저귀", "1팩", "no")])
        self.assertIn("남은 기저귀 약 10개", added[0]["memo"])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM google_record_events WHERE kind='shopping'").fetchone()[0], 1)
            db.execute("DELETE FROM items WHERE kind='shopping'")
        self.sync(NOW.replace(minute=5))
        self.assertEqual(self.shopping(), [])

    def test_no_second_item_when_diapers_are_already_on_the_list(self):
        self.stock(10)
        with self.store.connect() as db:
            db.execute("INSERT INTO items VALUES ('shopping','mine',?)", (encode({"id": "mine", "title": "하기스 기저귀 2단계", "quantity": "2", "done": "no"}),))
        self.sync(NOW.replace(minute=4))
        self.assertEqual([x["id"] for x in self.shopping()], ["mine"])


class DiaperSources(unittest.TestCase):
    """Stock is being tried two ways; the Mac follows whichever holds a 기저귀 count."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)

    def test_stock_list_then_earlier_setting_then_bought_shopping_items(self):
        with self.store.connect() as db:
            self.assertIsNone(diaper_source(db))
            for item_id, body in (("a", {"title": "기저귀", "quantity": "1", "done": "yes", "stockCount": "60", "stockAt": "2026-11-18T09:00"}),
                                  ("b", {"title": "하기스 기저귀", "quantity": "1", "done": "no", "stockCount": "40", "stockAt": "2026-11-20T09:00"}),
                                  ("c", {"title": "기저귀", "quantity": "1", "done": "yes"}),
                                  ("d", {"title": "물티슈", "quantity": "1", "done": "yes", "stockCount": "5", "stockAt": "2026-11-20T09:00"})):
                db.execute("INSERT INTO items VALUES ('shopping',?,?)", (item_id, encode({"id": item_id, **body})))
            self.assertEqual(diaper_source(db), {"count": 100, "at": "2026-11-18T09:00", "alertDays": 3})
            self.store.put_setting(db, "diaper_stock", {"count": 70, "at": "2026-11-19T09:00", "alertDays": 5})
            self.assertEqual(diaper_source(db), {"count": 70, "at": "2026-11-19T09:00", "alertDays": 5})
            self.store.put_setting(db, "stock", [{"id": "x", "name": "분유", "count": 2, "at": "2026-11-19T09:00"},
                                                 {"id": "y", "name": "기저귀", "count": 30, "at": "2026-11-21T09:00", "alertDays": 2}])
            self.assertEqual(diaper_source(db), {"count": 30, "at": "2026-11-21T09:00", "alertDays": 2})


if __name__ == "__main__":
    unittest.main()
