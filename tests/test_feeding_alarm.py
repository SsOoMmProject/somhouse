"""Feeding alarm: usual feeding times from the last 7 days and the single Calendar reminder that follows them."""
from datetime import datetime, timedelta
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from feeding_alarm import FeedingAlarm, feeding_times, next_alarm, usual_times
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


if __name__ == "__main__":
    unittest.main()
