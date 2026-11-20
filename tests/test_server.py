"""Exercise the actual HTTP API against an isolated temporary database."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import unquote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import FamilyServer, Store
from ai import CONFIG_NAME, LEGACY_CONFIG_NAME, AIError, Antigravity, Claude, Codex, remove_config, save_config
from google_records import GoogleAPI, GoogleError, GoogleRecords, TAB
from keep_sync import KeepSync


class FamilyAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="somhouse-api-")
        cls.store = Store(cls.temp.name)
        cls.store.password("family1", "test-password-1")
        cls.store.password("family2", "test-password-2")
        cls.server = FamilyServer(("127.0.0.1", 0), cls.store)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def setUp(self):
        with self.store.connect() as db:
            for table in ("items", "imports", "sessions", "keep_pending", "keep_notes", "google_record_events",
                          "google_voice_receipts", "google_task_links", "google_inbox_checkpoint",
                          "google_calendar_inputs", "google_calendar_checkpoint", "google_calendar_jobs",
                          "google_calendar_links", "google_shopping_jobs", "google_delivery_retries",
                          "google_service_state", "google_auth_state", "google_backfill_receipts", "google_sheet_state"):
                db.execute(f"DELETE FROM {table}")
        self.server.failures.clear()

    def request(self, path, method="GET", body=None, token=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if origin:
            headers["Origin"] = origin
        request = Request(self.base + path, method=method, headers=headers,
                          data=None if body is None else json.dumps(body).encode())
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        raw = response.read()
        response.close()
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw
        return response.status, data, response.headers

    def login(self, number=1):
        code, result, _ = self.request("/api/login", "POST", {"username": f"family{number}", "password": f"test-password-{number}"})
        self.assertEqual(code, 200)
        return result["token"]

    def item(self, key="a", title="테스트 물품"):
        return {"id": key, "title": title, "quantity": "1", "done": "no"}

    def blank(self, items=None):
        return {"records": [], "schedule": [], "shopping": items or []}

    def test_two_users_share_item_changes_without_replacing_other_records(self):
        first, second = self.login(), self.login(2)
        self.assertNotEqual(first, second)
        a, b = self.item(), self.item("b", "다른 휴대폰 물품")
        for token, item in ((first, a), (second, b)):
            self.assertEqual(self.request("/api/items/shopping/" + item["id"], "PUT", item, token)[0], 200)
        code, result, _ = self.request("/api/data", token=second)
        self.assertEqual(code, 200)
        self.assertEqual(len(result["data"]["shopping"]), 2)
        a["done"] = "yes"
        self.request("/api/items/shopping/a", "PUT", a, second)
        self.assertEqual(self.request("/api/data", token=first)[1]["data"]["shopping"][0]["done"], "yes")
        self.assertEqual(self.request("/api/items/shopping/b", "DELETE", token=first)[0], 200)
        reopened = Store(self.temp.name)
        with reopened.connect() as db:
            self.assertEqual(reopened.state(db)["shopping"], [a])

    def test_guest_sees_only_demo_records_and_can_change_nothing(self):
        family = self.login()
        secret = {"id": "real", "type": "hospital", "date": "2026-11-01T10:00", "hospital": "실제병원", "reason": "비공개"}
        self.assertEqual(self.request("/api/items/records/real", "PUT", secret, family)[0], 200)
        self.store.password("guest", "guest-password-1")
        code, login, _ = self.request("/api/login", "POST", {"username": "guest", "password": "guest-password-1"})
        self.assertEqual((code, login["read_only"]), (200, True))
        guest = login["token"]
        self.assertEqual(self.request("/api/me", token=guest)[1], {"username": "guest", "read_only": True,
                                                                     "family": {"home": True, "name": "우리 가족"}})
        code, view, _ = self.request("/api/data", token=guest)
        self.assertEqual(code, 200)
        self.assertTrue(view["read_only"])
        self.assertNotIn("실제병원", json.dumps(view, ensure_ascii=False))
        self.assertNotIn("sources", view)  # no links that would open the viewer's own Google account
        self.assertTrue(all(view["data"][k] for k in ("records", "schedule", "shopping")))
        from server import validate_data
        validate_data(view["data"])
        blocked = [("/api/items/records/real", "DELETE", None), ("/api/items/shopping/x", "PUT", self.item("x")),
                   ("/api/merge", "POST", self.blank([self.item("m")])), ("/api/confirm", "POST", {"forget": "부유"}),
                   ("/api/review", "POST", {"key": "k", "action": "dismiss"}),
                   ("/api/ai", "POST", {"question": "안녕", "scope": "none"}),
                   ("/api/password", "POST", {"currentPassword": "guest-password-1", "newPassword": "another-password-2"})]
        for path, method, body in blocked:
            self.assertEqual(self.request(path, method, body, guest)[0], 403, path)
        self.assertFalse(self.request("/api/ai", token=guest)[1]["enabled"])
        self.assertEqual(self.request("/api/data", token=family)[1]["data"],
                         {"records": [secret], "schedule": [], "shopping": []})
        self.assertNotIn("read_only", self.request("/api/data", token=family)[1])
        self.assertEqual(self.request("/api/logout", "POST", {}, guest)[0], 200)
        with self.store.connect() as db:
            db.execute("DELETE FROM users WHERE username='guest'")

    def test_feeding_ends_the_open_sleep_from_web_and_voice(self):
        token = self.login()
        put = lambda item: self.request("/api/items/records/" + item["id"], "PUT", item, token)
        sleep = {"id": "s", "type": "sleep", "date": "2026-11-18T13:00", "end": "", "category": "낮잠", "memo": ""}
        old = {"id": "old", "type": "sleep", "date": "2026-11-17T08:00", "end": "", "category": "낮잠"}
        for item in (old, sleep):
            self.assertEqual(put(item)[0], 200)
        # A feeding before the sleep started does not end it.
        put({"id": "f0", "type": "feeding", "date": "2026-11-18T12:30", "category": "분유", "amount": "100ml"})
        code, result, _ = put({"id": "f1", "type": "feeding", "date": "2026-11-18T14:10", "category": "분유", "amount": "120ml"})
        self.assertEqual(code, 200)
        records = {x["id"]: x for x in result["data"]["records"]}
        self.assertEqual(records["s"]["end"], "2026-11-18T14:10")
        self.assertEqual(records["old"]["end"], "")  # open for over 16 hours: left for a person to fix
        # Voice and Calendar inputs use the same rule and send the changed sleep to Google.
        from google_records import GoogleRecords
        queued = []
        fake = type("Fake", (), {"queue": lambda self, db, kind, item_id, item, action: queued.append((item_id, item["end"]))})()
        put({"id": "s2", "type": "sleep", "date": "2026-11-18T15:00", "end": "", "category": "낮잠"})
        with self.store.connect() as db:
            woke = GoogleRecords.wake_from_sleep(fake, db, {"type": "feeding", "date": "2026-11-18T16:05"})
        self.assertEqual(woke["end"], "2026-11-18T16:05")
        self.assertEqual(queued, [("s2", "2026-11-18T16:05")])
        with self.store.connect() as db:
            self.assertIsNone(GoogleRecords.wake_from_sleep(fake, db, {"type": "feeding", "date": "2026-11-18T17:00"}))

    def test_preflight_is_cached_by_the_browser(self):
        code, _, headers = self.request("/api/data", "OPTIONS", origin="https://ssoommproject.github.io")
        self.assertEqual((code, headers["Access-Control-Max-Age"]), (204, "600"))

    def test_google_sign_in_and_reconnect_accept_only_the_connected_account(self):
        import http.client, json as _json, os as _os
        import google_web
        from google_records import GoogleError, save_config
        directory = Path(self.temp.name)
        start = lambda mode, token=None, back="https://ssoommproject.github.io/somhouse/": self.request(
            "/api/google/start", "POST", {"mode": mode, "returnTo": back}, token)
        self.assertEqual(start("login")[0], 503)  # not set up yet
        client = directory / "client.json"
        client.write_text(_json.dumps({"web": {"client_id": "web-id", "client_secret": "web-secret",
            "redirect_uris": ["https://family.example/api/google/callback"]}}))
        google_web.save_web_client(directory, client, "https://family.example")
        save_config(directory, {"subject": "S1", "binding": "b"})
        _os.chmod(directory / "google-records.json", 0o600)

        def callback(url):
            state = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))["state"]
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
            connection.request("GET", f"/api/google/callback?state={state}&code=abc")
            response = connection.getresponse(); response.read(); connection.close()
            return response.status, response.getheader("Location")

        who = {"sub": "S1", "email_verified": True}
        tokens = {"access_token": "at"}
        with patch.object(google_web, "exchange", lambda *a: dict(tokens)), \
             patch.object(google_web, "identity", lambda token: dict(who)):
            code, body, _ = start("login", back="https://evil.example/steal")
            self.assertIn("scope=openid", body["url"]); self.assertNotIn("access_type=offline", body["url"])
            status, location = callback(body["url"])
            self.assertEqual(status, 302)
            self.assertTrue(location.startswith("https://ssoommproject.github.io/somhouse/#google="))  # never the evil origin
            one_time = location.split("#google=")[1]
            code, login, _ = self.request("/api/login/google", "POST", {"code": one_time})
            self.assertEqual((code, login["username"], login["read_only"]), (200, "family", False))
            self.assertEqual(self.request("/api/me", token=login["token"])[1]["username"], "family")
            self.assertEqual(self.request("/api/login/google", "POST", {"code": one_time})[0], 401)  # single use
            # Another Google account without a verified e-mail is refused (with one it gets its own family:
            # see test_families).
            who["sub"] = "S2"
            status, location = callback(start("login")[1]["url"])
            self.assertIn("#google-error=", location)
            who["sub"] = "S1"
            # A state can be used only once.
            url = start("login")[1]["url"]
            callback(url)
            self.assertIn("#google-error=", callback(url)[1])

            # Reconnect: signed-in family only, needs the running bridge, and keeps the old link if access fails.
            self.assertEqual(start("connect")[0], 401)
            family = login["token"]
            self.assertEqual(start("connect", family)[0], 409)  # no bridge running in this test server
            adopted = []
            fake = type("Bridge", (), {"calendar": None, "config": {"binding": "b", "subject": "S1"},
                                       "adopt_credentials": lambda self, *a: adopted.append(a)})()
            self.server.google = fake
            try:
                self.store.password("guest", "guest-password-1")
                guest = self.request("/api/login", "POST", {"username": "guest", "password": "guest-password-1"})[1]["token"]
                self.assertEqual(start("connect", guest)[0], 403)
                url = start("connect", family)[1]["url"]
                self.assertIn("access_type=offline", url); self.assertIn("auth%2Ftasks", url)
                self.assertIn("#google-error=", callback(url)[1])
                tokens["refresh_token"] = "new-refresh"
                tokens["scope"] = "openid https://www.googleapis.com/auth/calendar.events.owned"
                with patch.object(google_web, "check_access", side_effect=GoogleError(403, "Sheets")):
                    self.assertIn("#google-error=", callback(start("connect", family)[1]["url"])[1])
                self.assertEqual(adopted, [])
                with patch.object(google_web, "check_access", return_value=True):
                    status, location = callback(start("connect", family)[1]["url"])
                self.assertTrue(location.endswith("#google-connected=1"))
                self.assertEqual(adopted, [("web-id", "web-secret", "new-refresh", "at", {})])  # no calendar in this bridge
                adopted.clear()
                fake.calendar = object()
                with patch.object(google_web, "check_access", return_value=True):
                    callback(start("connect", family)[1]["url"])
                    tokens["scope"] = "openid"  # the person unticked calendar access
                    callback(start("connect", family)[1]["url"])
                self.assertEqual([a[4] for a in adopted], [{"calendar_write": True}, {"calendar_write": False}])
            finally:
                self.server.google = None
                with self.store.connect() as db:
                    db.execute("DELETE FROM users WHERE username='guest'")
                for name in ("google-web-client.json", "google-records.json", "client.json"):
                    (directory / name).unlink(missing_ok=True)

    def test_renewed_google_credentials_are_saved_and_resume_delivery(self):
        from google_records import read_config
        config = {"binding": "renew", "client_id": "old", "client_secret": "old-s", "refresh_token": "old-r",
                  "subject": "S1", "inbox": "@default", "task_list": "web", "spreadsheet": "sheet", "ready": True}
        bridge = GoogleRecords(self.store, config)
        bridge.require_reconnect()
        self.assertEqual(bridge.auth_state, "reconnect_required")
        try:
            bridge.adopt_credentials("web-id", "web-s", "new-r", "access")
            saved = read_config(Path(self.temp.name))
            self.assertEqual((saved["client_id"], saved["refresh_token"], saved["spreadsheet"]), ("web-id", "new-r", "sheet"))
            self.assertEqual((bridge.auth_state, bridge.api.token, bridge.api.config["client_id"]), ("ready", "access", "web-id"))
            self.assertEqual(GoogleRecords(self.store, saved).auth_state, "ready")  # survives a restart
        finally:
            (Path(self.temp.name) / "google-records.json").unlink(missing_ok=True)

    def test_diaper_changes_are_records_with_three_kinds(self):
        token = self.login()
        diaper = {"id": "d1", "type": "diaper", "date": "2026-11-20T05:55", "category": "소변", "memo": ""}
        self.assertEqual(self.request("/api/items/records/d1", "PUT", diaper, token)[0], 200)
        self.assertEqual(self.request("/api/items/records/d2", "PUT", {**diaper, "id": "d2", "category": "설사"}, token)[0], 400)
        records = self.request("/api/data", token=token)[1]["data"]["records"]
        self.assertEqual([(x["type"], x["category"]) for x in records], [("diaper", "소변")])
        from google_records import task_title
        self.assertEqual(task_title("records", diaper), "기저귀 · 소변 05:55")

    def test_feeding_alarm_needs_google_calendar(self):
        token = self.login(1)
        self.assertEqual(self.request("/api/feeding-alarm", "POST", {"enabled": "yes"}, token)[0], 400)
        code, body, _ = self.request("/api/feeding-alarm", "POST", {"enabled": True}, token)
        self.assertEqual((code, body["error"]), (409, "Google 캘린더를 연결하면 밥 알람을 켤 수 있어요."))
        # Turning it off always works and is shared through the family settings.
        code, body, _ = self.request("/api/feeding-alarm", "POST", {"enabled": False}, token)
        self.assertEqual((code, body["settings"]["feedingAlarm"]), (200, False))
        self.assertFalse(self.request("/api/data", token=token)[1]["settings"]["feedingAlarm"])

    def test_handoff_note_and_shared_breastfeeding_timer(self):
        import server as server_module
        token, other = self.login(1), self.login(2)
        try:
            # One line for the next caregiver, shared by every phone; an empty text clears it.
            self.assertEqual(self.request("/api/handoff", "POST", {"text": "x" * 201}, token)[0], 400)
            body = self.request("/api/handoff", "POST", {"text": "  약   먹였어요 "}, token)[1]
            self.assertEqual((body["settings"]["handoff"]["text"], body["settings"]["handoff"]["by"]), ("약 먹였어요", "family1"))
            self.assertEqual(self.request("/api/data", token=other)[1]["settings"]["handoff"]["text"], "약 먹였어요")
            self.assertIsNone(self.request("/api/handoff", "POST", {"text": ""}, other)[1]["settings"]["handoff"])

            # A sleep that is still open; the timer's feeding ends it at the feeding's start.
            self.request("/api/items/records/s1", "PUT", {"id": "s1", "type": "sleep", "date": "2026-11-20T09:00",
                                                         "end": "", "category": "낮잠"}, token)
            # Every timer request reads the clock once, refused ones too.
            clock = iter(["2026-11-20T09:59:00", "2026-11-20T10:00:00", "2026-11-20T10:01:00", "2026-11-20T10:08:10", "2026-11-20T10:15:00"])
            with patch.object(server_module, "local_now", lambda: next(clock)):
                self.assertEqual(self.request("/api/timer", "POST", {"action": "switch"}, token)[0], 409)
                started = self.request("/api/timer", "POST", {"action": "start", "side": "좌"}, token)[1]
                self.assertEqual(started["settings"]["timer"]["segments"], [{"side": "좌", "start": "2026-11-20T10:00:00"}])
                # The other phone sees the same timer and can switch sides and finish it.
                self.assertEqual(self.request("/api/data", token=other)[1]["settings"]["timer"]["by"], "family1")
                self.assertEqual(self.request("/api/timer", "POST", {"action": "start"}, other)[0], 409)
                switched = self.request("/api/timer", "POST", {"action": "switch"}, other)[1]
                self.assertEqual([x["side"] for x in switched["settings"]["timer"]["segments"]], ["좌", "우"])
                done = self.request("/api/timer", "POST", {"action": "finish"}, other)[1]
            self.assertIsNone(done["settings"]["timer"])
            saved = done["saved"]
            self.assertEqual((saved["category"], saved["amount"], saved["date"], saved["memo"]),
                             ("모유", "15분", "2026-11-20T10:00", "직수 타이머 · 좌 8분 · 우 7분"))
            records = {x["id"]: x for x in done["data"]["records"]}
            self.assertEqual(records["s1"]["end"], "2026-11-20T10:00")
            # Starting the timer ends the open sleep at once (same minute too, as at least 1 minute);
            # cancelling leaves no feeding and reopens that sleep.
            self.request("/api/items/records/s2", "PUT", {"id": "s2", "type": "sleep", "date": "2026-11-20T11:00",
                                                         "end": "", "category": "낮잠"}, token)
            with patch.object(server_module, "local_now", lambda: "2026-11-20T11:00:20"):
                started = self.request("/api/timer", "POST", {"action": "start"}, token)[1]
            self.assertEqual(started["woke"], {"id": "s2", "end": "2026-11-20T11:01"})
            self.assertEqual({x["id"]: x for x in started["data"]["records"]}["s2"]["end"], "2026-11-20T11:01")
            cancelled = self.request("/api/timer", "POST", {"action": "cancel"}, token)[1]
            self.assertIsNone(cancelled["settings"]["timer"])
            self.assertEqual({x["id"]: x for x in cancelled["data"]["records"]}["s2"]["end"], "")
            self.assertEqual(len(cancelled["data"]["records"]), 3)
            # A feeding saved in the same minute as 수면 시작 ends that sleep too.
            self.request("/api/items/records/f9", "PUT", {"id": "f9", "type": "feeding", "date": "2026-11-20T11:00",
                                                         "category": "분유", "amount": "60ml"}, token)
            records = {x["id"]: x for x in self.request("/api/data", token=token)[1]["data"]["records"]}
            self.assertEqual(records["s2"]["end"], "2026-11-20T11:01")
            self.store.password("guest", "guest-password-1")
            guest = self.request("/api/login", "POST", {"username": "guest", "password": "guest-password-1"})[1]["token"]
            self.assertEqual(self.request("/api/timer", "POST", {"action": "start"}, guest)[0], 403)
            self.assertEqual(self.request("/api/handoff", "POST", {"text": "a"}, guest)[0], 403)
        finally:
            with self.store.connect() as db:
                db.execute("DELETE FROM family_settings WHERE key IN ('handoff','timer')")
                db.execute("DELETE FROM users WHERE username='guest'")

    def test_children_names_are_shared_and_a_rename_moves_their_schedules(self):
        token = self.login()
        put = lambda body, t=token: self.request("/api/settings", "PUT", body, t)
        self.assertEqual(self.request("/api/data", token=token)[1]["settings"]["children"], [])
        plan = {"id": "s1", "date": "2026-11-20T10:00", "title": "검진", "who": "아기"}
        self.request("/api/items/schedule/s1", "PUT", plan, token)
        for bad in ({"children": ["엄마"]}, {"children": ["솜이", "솜이"]}, {"children": [""]}, {"children": ["a,b"]},
                    {"children": "솜이"}, {"children": ["솜이"], "rename": {"아기": "하늘"}}):
            self.assertEqual(put(bad)[0], 400, bad)
        code, body, _ = put({"children": ["솜이"], "rename": {"아기": "솜이"}})
        self.assertEqual((code, body["settings"]["children"], body["moved"]), (200, ["솜이"], 1))
        self.assertEqual(body["data"]["schedule"][0]["who"], "솜이")
        code, body, _ = put({"children": ["솜솜이", "하늘"], "rename": {"솜이": "솜솜이"}})
        self.assertEqual((body["data"]["schedule"][0]["who"], body["moved"]), ("솜솜이", 1))
        second = self.login(2)  # the other phone sees the same names
        self.assertEqual(self.request("/api/data", token=second)[1]["settings"]["children"], ["솜솜이", "하늘"])
        self.store.password("guest", "guest-password-1")
        try:
            guest = self.request("/api/login", "POST", {"username": "guest", "password": "guest-password-1"})[1]["token"]
            self.assertEqual(put({"children": ["x"]}, guest)[0], 403)
            self.assertEqual(self.request("/api/data", token=guest)[1]["settings"]["children"], ["하늘"])  # demo name
        finally:
            with self.store.connect() as db:
                db.execute("DELETE FROM users WHERE username='guest'")
                db.execute("DELETE FROM family_settings")

    def test_login_stays_active_until_logout_and_stores_hashes(self):
        self.assertEqual(self.request("/api/data")[0], 401)
        self.assertEqual(self.request("/api/login", "POST", {"username": "family1", "password": "wrong"})[0], 401)
        token = self.login()
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT token FROM sessions").fetchone()[0], hashlib.sha256(token.encode()).hexdigest())
            self.assertNotIn("test-password-1", db.execute("SELECT password FROM users WHERE username='family1'").fetchone()[0])
        with patch("server.time.time", return_value=time.time() + 365 * 86400):
            self.assertEqual(self.request("/api/data", token=token)[0], 200)
        self.assertEqual(self.request("/api/logout", "POST", {}, token)[0], 200)
        self.assertEqual(self.request("/api/data", token=token)[0], 401)

    def test_upgrade_keeps_only_previously_valid_legacy_sessions(self):
        active, expired = self.login(), self.login()
        now = time.time()
        with self.store.connect() as db:
            for token, expires in ((active, now + 60), (expired, now - 1)):
                db.execute("UPDATE sessions SET expires=? WHERE token=?",
                           (expires, hashlib.sha256(token.encode()).hexdigest()))
        with FamilyServer(("127.0.0.1", 0), Store(self.temp.name)):
            with patch("server.time.time", return_value=now + 365 * 86400):
                self.assertEqual(self.request("/api/data", token=active)[0], 200)
                self.assertEqual(self.request("/api/data", token=expired)[0], 401)

    def test_password_change_keeps_current_session_and_revokes_other_sessions(self):
        current, other_device, other_account = self.login(), self.login(), self.login(2)
        self.addCleanup(self.store.password, "family1", "test-password-1")
        path = "/api/password"
        body = {"currentPassword": "test-password-1", "newPassword": "가족이 함께 기억하는 문구"}
        self.assertEqual(self.request(path, "POST", body)[0], 401)
        self.assertEqual(self.request(path, "POST", dict(body, currentPassword="wrong"), current)[0], 403)
        self.assertEqual(self.request(path, "POST", dict(body, newPassword="too short"), current)[0], 400)
        self.assertEqual(self.request("/api/me", token=other_device)[0], 200)
        self.assertEqual(self.request(path, "POST", body, current)[0], 200)
        self.assertEqual(self.request("/api/me", token=current)[0], 200)
        self.assertEqual(self.request("/api/me", token=other_device)[0], 401)
        self.assertEqual(self.request("/api/me", token=other_account)[0], 200)
        for password, status in ((body["currentPassword"], 401), (body["newPassword"], 200)):
            self.assertEqual(self.request("/api/login", "POST", {"username": "family1", "password": password})[0], status)

    def test_merge_preserves_collisions_and_skips_repeat_after_edit_and_delete(self):
        token = self.login()
        a = self.item()
        self.request("/api/items/shopping/a", "PUT", a, token)
        changed = self.item("a", "ID는 같지만 다른 내용")
        batch = self.blank([a, changed, dict(a, id="another-phone-id")])
        code, result, _ = self.request("/api/merge", "POST", batch, token)
        self.assertEqual((code, result["added"], result["skipped"]), (200, 1, 2))
        self.assertEqual(len({x["id"] for x in result["data"]["shopping"]}), 2)
        self.request("/api/items/shopping/a", "PUT", dict(a, title="이전 후 수정"), token)
        imported_id = next(x["id"] for x in result["data"]["shopping"] if x["id"] != "a")
        self.request("/api/items/shopping/"+imported_id, "DELETE", token=token)
        result = self.request("/api/merge", "POST", batch, token)[1]
        self.assertEqual((result["added"], result["skipped"]), (0, 3))
        self.assertEqual(result["data"]["shopping"], [dict(a, title="이전 후 수정")])

    def test_invalid_backup_is_atomic_and_backups_capture_previous_state(self):
        token = self.login()
        a = self.item()
        self.request("/api/items/shopping/a", "PUT", a, token)
        bad = self.blank([self.item("b"), {"id": "invalid"}])
        self.assertEqual(self.request("/api/merge", "POST", bad, token)[0], 400)
        self.assertEqual(self.request("/api/data", token=token)[1]["data"], self.blank([a]))
        self.request("/api/items/shopping/a", "DELETE", token=token)
        backups = [json.loads(p.read_text()) for p in (Path(self.temp.name)/"backups").glob("*.json")]
        self.assertIn(self.blank([a]), backups)
        with patch.object(self.store, "snapshot", side_effect=OSError("disk full")):
            self.assertEqual(self.request("/api/items/shopping/a", "PUT", a, token)[0], 503)
        self.assertEqual(self.request("/api/data", token=token)[1]["data"], self.blank())

    def test_explicit_backup_restore_can_recover_deleted_imported_records(self):
        token = self.login()
        backup = self.blank([self.item()])
        self.request("/api/merge", "POST", backup, token)
        self.request("/api/items/shopping/a", "DELETE", token=token)
        self.assertEqual(self.request("/api/merge", "POST", backup, token)[1]["added"], 0)
        # A normal family login cannot use the administrator restore path.
        self.assertEqual(self.request("/api/restore", "POST", backup, token)[0], 404)
        path = Path(self.temp.name) / "restore-input.json"
        path.write_text(json.dumps(backup), encoding="utf-8")
        result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1]/"server.py"), "restore", "--data-dir", self.temp.name, "--file", str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.request("/api/data", token=token)[1]["data"], backup)

    def test_admin_backup_and_invalid_restore_preserve_current_data(self):
        token = self.login()
        a = self.item()
        self.request("/api/items/shopping/a", "PUT", a, token)
        command = [sys.executable, str(Path(__file__).resolve().parents[1]/"server.py")]
        result = subprocess.run(command+["backup", "--data-dir", self.temp.name], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        path = Path(result.stdout.strip().split(": ", 1)[1])
        self.assertEqual(json.loads(path.read_text()), self.blank([a]))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        invalid = Path(self.temp.name) / "invalid.json"
        invalid.write_text('{"records":[]}', encoding="utf-8")
        result = subprocess.run(command+["restore", "--data-dir", self.temp.name, "--file", str(invalid)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.request("/api/data", token=token)[1]["data"], self.blank([a]))

    def test_two_frontend_sessions_automatically_follow_real_api_changes(self):
        self.addCleanup(self.store.password, "family1", "test-password-1")
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for the frontend integration check")
        script = Path(__file__).with_name("two_clients.cjs")
        result = subprocess.run([node, str(script), self.base], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with self.store.connect() as db:
            self.assertEqual(self.store.state(db), self.blank())

    def test_feeding_hospital_and_schedule_are_shared_with_legacy_fields(self):
        first, second = self.login(), self.login(2)
        entries = [
            ("records", {"id": "feed", "type": "feeding", "date": "2026-11-02T15:00", "category": "분유", "amount": "80ml", "memo": ""}),
            ("records", {"id": "hospital", "type": "hospital", "date": "2026-11-02T16:00", "hospital": "가상 병원", "reason": "검진"}),
            ("schedule", {"id": "schedule", "date": "2026-11-03T10:00", "title": "가상 일정"}),
        ]
        for kind, item in entries:
            self.assertEqual(self.request(f"/api/items/{kind}/{item['id']}", "PUT", item, first)[0], 200)
        state = self.request("/api/data", token=second)[1]["data"]
        self.assertEqual(state["records"], [x for k, x in entries if k == "records"])
        self.assertEqual(state["schedule"], [entries[2][1]])

    def test_google_records_use_one_web_copy_and_preserve_voice_original(self):
        bridge = GoogleRecords(self.store, {"binding": "demo", "inbox": "@default", "task_list": "archive",
                                           "spreadsheet": "test-sheet"})
        input_tasks = [{"id": "voice", "title": "솜하우스 수유 분유 120 밀리리터",
                        "updated": "2026-11-15T15:00:00.000Z"},
                       {"id": "personal", "title": "개인 일정"},
                       {"id": "ambiguous", "title": "솜하우스 수유 분유 조금"}]
        copied, sheet = {}, {}
        lose_response = True

        def list_tasks(task_list, updated_min=None):
            return iter(input_tasks if task_list == "@default" else copied.values())

        def put_task(task_list, body, task_id=None):
            nonlocal lose_response
            self.assertEqual(task_list, "archive")
            task_id = task_id or f"copy-{len(copied) + 1}"
            copied[task_id] = dict(body, id=task_id)
            if lose_response:
                lose_response = False
                raise GoogleError("응답 유실", "Tasks")
            return copied[task_id]

        with patch.object(self.server, "google", bridge), \
                patch.object(bridge.api, "tasks", side_effect=list_tasks), \
                patch.object(bridge.api, "put_task", side_effect=put_task), \
                patch.object(bridge.api, "sheet_row", side_effect=lambda row, values: sheet.update({row: values})):
            token = self.login()
            path = "/api/items/shopping/a"
            web_item = self.item()
            self.assertEqual(self.request(path, "PUT", web_item, token)[0], 200)
            bridge.pull()
            bridge.pull()
            state = self.request("/api/data", token=token)[1]
            self.assertEqual(state["data"]["shopping"], [web_item])
            [feeding] = state["data"]["records"]
            self.assertEqual(feeding["amount"], "120ml")
            self.assertEqual(feeding["date"], "2026-11-16T00:00")
            self.assertEqual(state["sources"]["sheet"], "https://docs.google.com/spreadsheets/d/test-sheet/edit")
            self.assertEqual(self.request("/api/data")[0], 401)

            bridge.deliver("tasks")
            with self.store.connect() as db:
                self.assertEqual(db.execute("SELECT attempts FROM google_delivery_retries").fetchone()[0], 1)
                db.execute("UPDATE google_delivery_retries SET next_retry_at=0")
            bridge.deliver("sheets")
            self.assertEqual([r[7] for r in sheet.values()], ["저장", "저장", "확인 필요"])
            self.assertEqual(json.loads(sheet[3][9])["title"], input_tasks[0]["title"])
            bridge.deliver("tasks")
            self.assertEqual(list(copied), ["copy-1"])

            self.assertEqual(self.request(path, "PUT", dict(web_item, done="yes"), token)[0], 200)
            voice_path = "/api/items/records/" + feeding["id"]
            self.assertEqual(self.request(voice_path, "PUT", dict(feeding, amount="125ml"), token)[0], 200)
            bridge.deliver("tasks")
            self.assertEqual(list(copied), ["copy-1"])
            self.assertEqual(copied["copy-1"]["status"], "completed")
            self.assertEqual(input_tasks[0]["title"], "솜하우스 수유 분유 120 밀리리터")

            input_tasks[2]["title"] = "솜하우스 수유 분유 50ml"
            bridge.pull()
            self.assertEqual(len(self.request("/api/data", token=token)[1]["data"]["records"]), 2)
            self.assertEqual(self.request(path, "DELETE", token=token)[0], 200)
            bridge.deliver("sheets")
            bridge.deliver("tasks")
            self.assertTrue(copied["copy-1"]["title"].startswith("삭제 · "))
            self.assertEqual(list(copied), ["copy-1"])
            self.assertEqual(len(sheet), 7)
            self.assertEqual(sheet[8][4], "shopping")
            self.assertEqual(sheet[8][3], "delete")

    def test_google_sheet_retries_same_row_and_rejects_another_events_cell(self):
        api = GoogleAPI({"spreadsheet": "test-sheet"})
        api.sheet_size = (0, 1000, 20)
        values = ["same-event", '=IMPORTXML("not a formula")']
        with patch.object(api, "sheet_cell", side_effect=[[], [["same-event"]], [["different-event"]]]), \
                patch.object(api, "request", return_value={}) as request:
            api.sheet_row(2, values)
            api.sheet_row(2, values)
            self.assertEqual(request.call_args_list[0], request.call_args_list[1])
            url, method, body, _ = request.call_args.args
            self.assertEqual(method, "PUT")
            self.assertTrue(unquote(url).endswith(f"/'{TAB}'!A2?valueInputOption=RAW"))
            self.assertEqual(body, {"values": [values]})
            with self.assertRaises(GoogleError):
                api.sheet_row(2, values)
            self.assertEqual(request.call_count, 2)

    def test_calendar_intake_uses_event_time_and_web_mirror_recovers_a_lost_reply(self):
        bridge = GoogleRecords(self.store, {"binding": "calendar-demo", "inbox": "@default", "task_list": "archive",
                                           "spreadsheet": "test-sheet", "calendar_inbox": "primary",
                                           "calendar_outbox": "app-cal"})
        calendar = bridge.calendar
        event = {"id": "voice", "summary": "솜하우스 수유 분유 120 밀리리터",
                 "start": {"dateTime": "2026-11-16T05:30:00Z"}}
        remote = {}
        lose_reply = True

        def google(url, method="GET", body=None, service=None):
            nonlocal lose_reply
            self.assertIn("/app-cal/events", url)
            if method == "POST":
                key = body["id"]
                self.assertNotIn(key, remote)
                remote[key] = body.copy()
                if lose_reply:
                    lose_reply = False
                    raise GoogleError("응답 유실", "Calendar")
                return body
            key = url.split("?")[0].rsplit("/", 1)[-1]
            if method == "PATCH":
                remote[key].update(body)
            elif method == "DELETE":
                del remote[key]
            return {}

        with patch.object(self.server, "google", bridge), patch.object(bridge.api, "request", side_effect=google):
            token = self.login()
            calendar.record(event)
            calendar.record(event)
            calendar.record(dict(event, id="recurring", recurrence=["RRULE:FREQ=DAILY"]))
            calendar.record(dict(event, id="private", summary="개인 일정"))
            source = self.request("/api/data", token=token)[1]
            [voice] = source["data"]["records"]
            self.assertEqual((voice["date"], voice["amount"]), ("2026-11-16T14:30", "120ml"))
            self.assertEqual(source["sources"]["calendar"], "https://calendar.google.com/calendar/r")
            calendar.record(dict(event, summary="솜하우스 수유 분유 125ml"))
            [voice] = self.request("/api/data", token=token)[1]["data"]["records"]
            self.assertEqual(voice["amount"], "125ml")
            self.assertEqual(self.request("/api/items/records/" + voice["id"], "PUT",
                                          dict(voice, amount="130ml"), token)[0], 200)
            calendar.record(dict(event, summary="솜하우스 수유 분유 140ml"))
            self.assertEqual(self.request("/api/data", token=token)[1]["data"]["records"][0]["amount"], "130ml")
            calendar.flush()
            self.assertFalse(remote)

            web = dict(voice, id="web", date="2026-11-16T16:10", amount="80ml")
            self.assertEqual(self.request("/api/items/records/web", "PUT", web, token)[0], 200)
            calendar.flush()
            with self.store.connect() as db:
                self.assertEqual(db.execute("SELECT attempts FROM google_delivery_retries").fetchone()[0], 1)
                db.execute("UPDATE google_delivery_retries SET next_retry_at=0")
            [event_id] = remote
            calendar.flush()
            self.assertEqual(list(remote), [event_id])
            self.assertEqual(remote[event_id]["start"]["dateTime"], "2026-11-16T16:10:00+09:00")
            self.assertEqual(self.request("/api/items/records/web", "PUT", dict(web, amount="90ml"), token)[0], 200)
            calendar.flush()
            self.assertIn("90ml", remote[event_id]["summary"])
            self.assertEqual(self.request("/api/items/records/web", "DELETE", token=token)[0], 200)
            calendar.flush()
            self.assertFalse(remote)
            self.assertEqual(len(self.request("/api/data", token=token)[1]["data"]["records"]), 1)

    def test_review_inputs_are_corrected_or_dismissed_on_the_web_without_duplicates(self):
        bridge = GoogleRecords(self.store, {"binding": "review-demo", "inbox": "@default", "task_list": "archive",
                                           "spreadsheet": "test-sheet", "calendar_inbox": "primary",
                                           "calendar_outbox": "app-cal"})
        start = {"dateTime": "2026-11-16T22:12:00Z"}
        unclear = {"id": "ev1", "summary": "수유 100미리 병원", "start": start}
        with patch.object(self.server, "google", bridge):
            token = self.login()
            bridge.calendar.record(unclear)
            bridge.record_voice({"id": "t1", "title": "솜하우스 수유 조금", "updated": "2026-11-16T22:00:00Z"})
            bridge.record_voice({"id": "t2", "title": "솜하우스 수유 많이", "updated": "2026-11-16T22:05:00Z"})
            status = self.request("/api/data", token=token)[1]["google_status"]
            self.assertEqual(status["review"], 3)
            entries = {x["key"]: x for x in status["review_items"]}
            self.assertEqual(entries["calendar:ev1"]["when"], "2026-11-17T07:12")
            self.assertEqual(entries["calendar:ev1"]["suggest"], {"category": "기타", "amount": "100ml"})
            self.assertEqual(entries["tasks:t1"]["title"], "솜하우스 수유 조금")

            item = {"type": "feeding", "date": "2026-11-17T07:12", "category": "분유", "amount": "100ml", "memo": ""}
            code, body, _ = self.request("/api/review", "POST",
                                      {"key": "calendar:ev1", "action": "save", "kind": "records", "item": item}, token)
            self.assertEqual(code, 200)
            [saved] = body["data"]["records"]
            self.assertTrue(saved["id"].startswith("cal-"))
            self.assertEqual(body["google_status"]["review"], 2)
            # A second tap (another phone, a retry) cannot create a duplicate.
            code, _, _ = self.request("/api/review", "POST",
                                   {"key": "calendar:ev1", "action": "save", "kind": "records", "item": item}, token)
            self.assertEqual(code, 409)
            # A later edit of the Calendar event keeps the web correction.
            bridge.calendar.record(dict(unclear, summary="수유 120미리"))
            [kept] = self.request("/api/data", token=token)[1]["data"]["records"]
            self.assertEqual(kept["category"], "분유")

            code, body, _ = self.request("/api/review", "POST",
                                      {"key": "tasks:t1", "action": "save", "kind": "records",
                                       "item": dict(item, amount="60ml")}, token)
            self.assertEqual(code, 200)
            self.assertEqual(len(body["data"]["records"]), 2)
            # The resolved Task is not imported again when its title changes later.
            bridge.record_voice({"id": "t1", "title": "솜하우스 수유 분유 60ml", "updated": "2026-11-16T23:00:00Z"})
            self.assertEqual(len(self.request("/api/data", token=token)[1]["data"]["records"]), 2)

            code, body, _ = self.request("/api/review", "POST", {"key": "tasks:t2", "action": "dismiss"}, token)
            self.assertEqual(code, 200)
            self.assertEqual(len(body["data"]["records"]), 2)
            remaining = body["google_status"]
            self.assertEqual(remaining["review"], 1)  # the edited Calendar event now differs from the web record
            self.assertEqual([x["status"] for x in remaining["review_items"]], ["웹 기록 유지"])

            for bad in ({"key": "tasks:none", "action": "dismiss"}, {"key": "other:x", "action": "dismiss"}):
                self.assertEqual(self.request("/api/review", "POST", bad, token)[0], 409)
            self.assertEqual(self.request("/api/review", "POST", {"key": "tasks:t2", "action": "erase"}, token)[0], 400)
            self.assertEqual(self.request("/api/review", "POST",
                                          {"key": "calendar:ev1", "action": "save", "kind": "records",
                                           "item": {"type": "feeding"}}, token)[0], 400)
            self.assertEqual(self.request("/api/review", "POST", {"key": "tasks:t2", "action": "dismiss"})[0], 401)
            with self.store.connect() as db:
                history = db.execute("""SELECT source,action,status FROM google_record_events
                    WHERE binding='review-demo' AND source='web' ORDER BY seq""").fetchall()
            self.assertEqual(history, [("web", "save", "저장"), ("web", "save", "저장"), ("web", "dismiss", "확인 필요 무시")])

    def test_feeding_kind_is_confirmed_with_one_tap_and_new_words_are_learned(self):
        bridge = GoogleRecords(self.store, {"binding": "kind-demo", "inbox": "@default", "task_list": "archive",
                                           "spreadsheet": "test-sheet", "calendar_inbox": "primary",
                                           "calendar_outbox": "app-cal"})
        start = {"dateTime": "2026-11-16T22:12:00Z"}
        with patch.object(self.server, "google", bridge):
            token = self.login()
            bridge.calendar.record({"id": "e1", "summary": "부유 100ml", "start": start})
            bridge.calendar.record({"id": "e2", "summary": "수유 80ml", "start": start})
            _, body, _ = self.request("/api/data", token=token)
            self.assertEqual(body["aliases"], {})
            flagged = {x["amount"]: x for x in body["data"]["records"]}
            self.assertEqual((flagged["100ml"]["confirm"], flagged["100ml"]["heard"]), ("category", "부유"))
            self.assertEqual(flagged["80ml"]["confirm"], "category")

            code, body, _ = self.request("/api/confirm", "POST",
                                         {"id": flagged["100ml"]["id"], "category": "분유"}, token)
            self.assertEqual(code, 200)
            self.assertEqual(body["aliases"], {"부유": "분유"})
            saved = {x["amount"]: x for x in body["data"]["records"]}["100ml"]
            self.assertEqual((saved["category"], "confirm" in saved, saved["heard"]), ("분유", False, "부유"))
            self.assertEqual(self.request("/api/confirm", "POST",
                                          {"id": saved["id"], "category": "모유"}, token)[0], 409)
            # The learned word is recognised from now on; a kind-less 수유 teaches nothing.
            bridge.calendar.record({"id": "e3", "summary": "부유 60ml", "start": start})
            code, body, _ = self.request("/api/confirm", "POST",
                                         {"id": flagged["80ml"]["id"], "category": "기타"}, token)
            self.assertEqual((code, body["aliases"]), (200, {"부유": "분유"}))
            records = {x["amount"]: x for x in body["data"]["records"]}
            self.assertEqual((records["60ml"]["category"], "confirm" in records["60ml"]), ("분유", False))
            self.assertNotIn("confirm", records["80ml"])

            code, body, _ = self.request("/api/confirm", "POST", {"forget": "부유"}, token)
            self.assertEqual((code, body["aliases"]), (200, {}))
            bridge.calendar.record({"id": "e4", "summary": "부유 40ml", "start": start})
            again = {x["amount"]: x for x in self.request("/api/data", token=token)[1]["data"]["records"]}["40ml"]
            self.assertEqual((again["category"], again["confirm"]), ("기타", "category"))

            for bad in ({"id": again["id"], "category": "주스"}, {"id": "", "category": "분유"}, {}):
                self.assertEqual(self.request("/api/confirm", "POST", bad, token)[0], 400)
            self.assertEqual(self.request("/api/confirm", "POST", {"id": "none", "category": "분유"}, token)[0], 409)
            self.assertEqual(self.request("/api/confirm", "POST", {"id": again["id"], "category": "분유"})[0], 401)

            # A wrong pick is corrected by editing the record: 부유 -> 모유 by mistake, then 분유 in the form.
            code, body, _ = self.request("/api/confirm", "POST", {"id": again["id"], "category": "모유"}, token)
            self.assertEqual(body["aliases"], {"부유": "모유"})
            wrong = next(x for x in body["data"]["records"] if x["id"] == again["id"])
            code, body, _ = self.request("/api/items/records/" + wrong["id"], "PUT", dict(wrong, category="분유"), token)
            self.assertEqual((code, body["aliases"]), (200, {"부유": "분유"}))
            # A record that lost its heard field still teaches through the memo's 음성 원문.
            legacy = {k: v for k, v in wrong.items() if k != "heard"}
            code, body, _ = self.request("/api/items/records/" + wrong["id"], "PUT", dict(legacy, category="혼합"), token)
            self.assertEqual(body["aliases"], {"부유": "혼합"})
            # 기타 and unrelated records leave what was learned alone.
            code, body, _ = self.request("/api/items/records/" + wrong["id"], "PUT", dict(legacy, category="기타"), token)
            self.assertEqual(body["aliases"], {"부유": "혼합"})
            plain = {"id": "plain", "type": "feeding", "date": "2026-11-17T08:00", "category": "모유",
                     "amount": "15분", "memo": "음성 원문: 수육 기록 1 100mm"}
            self.assertEqual(self.request("/api/items/records/plain", "PUT", plain, token)[1]["aliases"], {"부유": "혼합"})
            bridge.calendar.record({"id": "e6", "summary": "부유 30ml", "start": start})
            latest = {x["amount"]: x for x in self.request("/api/data", token=token)[1]["data"]["records"]}["30ml"]
            self.assertEqual((latest["category"], "confirm" in latest, latest["heard"]), ("혼합", False, "부유"))
            self.request("/api/confirm", "POST", {"forget": "부유"}, token)

            # Correcting an unclear input on the review page teaches its new word too.
            bridge.calendar.record({"id": "e5", "summary": "머유 50ml 병원", "start": start})
            item = {"type": "feeding", "date": "2026-11-17T07:12", "category": "모유", "amount": "50ml", "memo": ""}
            code, body, _ = self.request("/api/review", "POST",
                                         {"key": "calendar:e5", "action": "save", "kind": "records", "item": item}, token)
            self.assertEqual(code, 200)
            self.assertEqual(self.request("/api/data", token=token)[1]["aliases"], {"머유": "모유"})

    def test_calendar_writeback_endpoint_queues_only_allowed_requests(self):
        config = {"binding": "wb-demo", "inbox": "@default", "task_list": "archive", "spreadsheet": "test-sheet",
                  "calendar_inbox": "primary", "calendar_outbox": "app-cal"}
        reader, writer = GoogleRecords(self.store, config), GoogleRecords(self.store, dict(config, calendar_write=True))
        event = {"id": "w1", "summary": "분유 10ml", "etag": '"e1"', "start": {"dateTime": "2026-11-17T14:00:00+09:00"}}
        writer.calendar.record(event)
        token = self.login()
        with patch.object(self.server, "google", reader):
            [record] = self.request("/api/data", token=token)[1]["data"]["records"]
            self.assertFalse(self.request("/api/data", token=token)[1]["google_status"]["calendar_write"])
            code, body, _ = self.request("/api/calendar-writeback", "POST", {"id": record["id"]}, token)
            self.assertEqual(code, 409)
            self.assertIn("권한", body["error"])
        with patch.object(self.server, "google", writer):
            self.assertEqual(self.request("/api/calendar-writeback", "POST", {"id": record["id"]}, token)[0], 409)
            self.assertEqual(self.request("/api/items/records/" + record["id"], "PUT",
                                          dict(record, amount="20ml"), token)[0], 200)
            code, body, _ = self.request("/api/calendar-writeback", "POST", {"id": record["id"]}, token)
            self.assertEqual((code, body["title"], body["google_status"]["calendar_write"]), (200, "분유 20ml", True))
            self.assertEqual(self.request("/api/calendar-writeback", "POST", {"id": ""}, token)[0], 400)
            self.assertEqual(self.request("/api/calendar-writeback", "POST", {"id": record["id"]})[0], 401)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT event_id FROM google_calendar_writebacks").fetchall(), [("w1",)])

    def test_existing_database_gains_the_calendar_etag_column(self):
        import sqlite3
        directory = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, directory)
        with sqlite3.connect(directory / "somhouse.sqlite3") as db:
            db.execute("""CREATE TABLE google_calendar_inputs (binding TEXT NOT NULL, inbox TEXT NOT NULL,
                event_id TEXT NOT NULL, item_id TEXT NOT NULL, fingerprint TEXT NOT NULL, applied TEXT,
                review INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (binding, inbox, event_id))""")
            db.execute("INSERT INTO google_calendar_inputs VALUES ('b','primary','e','cal-x','[]',NULL,1)")
        store = Store(directory)
        with store.connect() as db:
            self.assertEqual(db.execute("SELECT review,etag FROM google_calendar_inputs").fetchall(), [(1, "")])

    def test_family_data_includes_mirrored_google_events_only_with_calendar(self):
        config = {"binding": "view-demo", "inbox": "@default", "task_list": "archive", "spreadsheet": "test-sheet"}
        plain, linked = GoogleRecords(self.store, config), GoogleRecords(self.store, dict(config, calendar_inbox="primary", calendar_outbox="app-cal"))
        with self.store.connect() as db:
            db.execute("INSERT INTO google_calendar_view VALUES ('view-demo','e1','2026-11-20T19:00','2026-11-20T21:00',0,'엄마 약속','')")
        token = self.login()
        with patch.object(self.server, "google", linked):
            events = self.request("/api/data", token=token)[1]["calendar_events"]
            self.assertEqual(events, [{"id": "e1", "date": "2026-11-20T19:00", "end": "2026-11-20T21:00",
                                       "allDay": False, "title": "엄마 약속", "link": ""}])
        with patch.object(self.server, "google", plain):
            self.assertNotIn("calendar_events", self.request("/api/data", token=token)[1])
        self.assertNotIn("calendar_events", self.request("/api/data", token=token)[1])

    def test_family_data_lists_holidays_and_tests_never_download_them(self):
        self.assertFalse(self.server.holiday_feed)
        from datetime import date
        day = date.today().isoformat()
        with self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO holidays VALUES (?,?,1)", (day, "광복절"))
        token = self.login()
        holidays = self.request("/api/data", token=token)[1]["holidays"]
        self.assertIn({"date": day, "name": "광복절", "substitute": True}, holidays)
        with self.store.connect() as db:
            db.execute("DELETE FROM holidays")

    def test_sleep_records_are_validated_and_confirmed_with_sleep_kinds(self):
        token = self.login()
        ok = {"id": "sl1", "type": "sleep", "date": "2026-11-17T13:00", "end": "2026-11-17T13:40", "category": "낮잠", "memo": ""}
        self.assertEqual(self.request("/api/items/records/sl1", "PUT", ok, token)[0], 200)
        self.assertEqual(self.request("/api/items/records/sl2", "PUT", dict(ok, id="sl2", end=""), token)[0], 200)
        for bad in (dict(ok, category="분유"), dict(ok, end="2026-11-17T12:00"), dict(ok, category="")):
            self.assertEqual(self.request("/api/items/records/sl1", "PUT", bad, token)[0], 400)
        with self.store.connect() as db:
            db.execute("UPDATE items SET body=? WHERE id='sl2'", (json.dumps(dict(ok, id="sl2", confirm="category")),))
        self.assertEqual(self.request("/api/confirm", "POST", {"id": "sl2", "category": "분유"}, token)[0], 400)
        code, body, _ = self.request("/api/confirm", "POST", {"id": "sl2", "category": "밤잠"}, token)
        saved = next(x for x in body["data"]["records"] if x["id"] == "sl2")
        self.assertEqual((code, saved["category"], "confirm" in saved), (200, "밤잠", False))
        for item_id in ("sl1", "sl2"):
            self.request("/api/items/records/" + item_id, "DELETE", token=token)

    def test_purchase_task_notes_keep_user_text_and_compare_only_matching_current_prices(self):
        bridge = GoogleRecords(self.store, {"binding": "shopping-demo", "inbox": "@default", "task_list": "archive",
                                           "spreadsheet": "test-sheet"})
        tasks = {"plain": {"id": "plain", "title": "솜하우스 구매 아기 기저기", "notes": "직접 쓴 메모"},
                 "specific": {"id": "specific", "title": "솜하우스 구매 샘플브랜드 기저귀 4단계 40매",
                              "notes": "원래 메모", "etag": "version"},
                 "old": {"id": "old", "title": "개인 용품 구매하기", "status": "completed"}}
        results = {"shopping_results": [
            {"title": "샘플브랜드 기저귀 4단계 20매", "price": "6,000원", "product_link": "https://example.com/small"},
            {"title": "샘플브랜드 기저귀 5단계 40매", "price": "7,000원", "product_link": "https://example.com/other"},
            {"title": "샘플브랜드 기저귀 4단계 40매", "price": "$5", "product_link": "https://example.com/usd"},
            {"title": "샘플브랜드 기저귀 4단계 40매", "price": "15,000원", "product_link": "https://example.com/high"},
            {"title": "샘플브랜드 기저귀 4단계 40매", "price": "₩12,900", "product_link": "https://example.com/low"},
        ]}
        lost_patch = True

        def patch_notes(task_list, body, task_id, *, etag):
            nonlocal lost_patch
            self.assertEqual(task_list, "@default")
            self.assertEqual(set(body), {"notes"})
            self.assertEqual(etag, tasks[task_id].get("etag"))
            tasks[task_id].update(body)
            if lost_patch:
                lost_patch = False
                raise GoogleError("응답 유실", "Tasks")
            return tasks[task_id]

        bridge.shopping.settings = {"serpapi_key": "fake"}
        with patch.object(self.server, "google", bridge), \
                patch.object(bridge.api, "get_task", side_effect=lambda _, task_id: tasks[task_id]), \
                patch.object(bridge.api, "put_task", side_effect=patch_notes), \
                patch("shopping_records.json_request", return_value=results) as search:
            token = self.login()
            for task in tasks.values():
                bridge.record_voice(task)
            bridge.shopping.flush()
            with self.store.connect() as db:
                self.assertEqual(db.execute("SELECT attempts FROM google_delivery_retries").fetchone()[0], 1)
                db.execute("UPDATE google_delivery_retries SET next_retry_at=0")
            bridge.shopping.flush()
            bridge.record_voice(tasks["plain"])
            bridge.shopping.flush()
            self.assertEqual(tasks["plain"]["notes"].count("[솜하우스 가격비교]"), 1)
            self.assertTrue(tasks["plain"]["notes"].startswith("직접 쓴 메모\n"))
            self.assertIn("규격 확인 필요", tasks["plain"]["notes"])
            self.assertIn("가격비교: https://www.google.com/search?", tasks["plain"]["notes"])
            self.assertIn("최저 표시가: 12,900원", tasks["specific"]["notes"])
            self.assertIn("https://example.com/low", tasks["specific"]["notes"])
            self.assertEqual(search.call_count, 1)
            items = self.request("/api/data", token=token)[1]["data"]["shopping"]
            self.assertEqual(len(items), 2)
            self.assertEqual(items[0]["title"], "아기 기저귀")
            self.assertEqual(items[1]["url"], "https://example.com/low")

    def test_keep_retries_a_web_save_after_restart_and_preserves_a_concurrent_edit(self):
        keep = KeepSync(self.store, "test@example.com")
        token = self.login()
        path = "/api/items/records/feed"
        first = {"id": "feed", "type": "feeding", "date": "2026-11-13T10:00",
                 "category": "분유", "amount": "120ml", "memo": "시험 메모"}
        latest = dict(first, amount="130ml")
        with patch.object(self.server, "keep", keep):
            self.assertEqual(self.request(path, "PUT", first, token)[0], 200)
            with patch.object(keep, "send", side_effect=RuntimeError("network")):
                with self.assertRaises(RuntimeError):
                    keep.flush()
            self.assertEqual(self.request("/api/data", token=token)[1]["data"]["records"], [first])
            reopened = KeepSync(Store(self.temp.name), keep.email)

            def concurrent_edit(entries):
                self.assertEqual([(e["item"], e["note_ids"]) for e in entries], [(first, {})])
                self.assertEqual(self.request(path, "PUT", latest, token)[0], 200)
                return [{"1": "keep-note"}]

            with patch.object(reopened, "send", side_effect=concurrent_edit):
                self.assertTrue(reopened.flush())
            with patch.object(reopened, "send", return_value=[{"1": "keep-note"}]) as send:
                self.assertTrue(reopened.flush())
                saved = send.call_args.args[0][0]
                self.assertEqual((saved["item"], saved["note_ids"]), (latest, {"1": "keep-note"}))
                send.reset_mock()
                self.assertEqual(self.request(path, "DELETE", token=token)[0], 200)
                self.assertTrue(reopened.flush())
                send.assert_called_once_with([dict(saved, item=None)])
                self.assertFalse(reopened.flush())

    def test_keep_does_not_send_changes_to_a_replaced_account_or_replay_stale_records(self):
        keep = KeepSync(self.store, "first@example.com")
        other = KeepSync(self.store, "second@example.com")
        token = self.login()
        path = "/api/items/shopping/a"
        with patch.object(self.server, "keep", keep):
            self.assertEqual(self.request(path, "PUT", self.item(), token)[0], 200)
        with patch.object(other, "send") as send:
            self.assertFalse(other.flush())
            send.assert_not_called()

        with patch.object(self.server, "keep", other):
            self.assertEqual(self.request(path, "PUT", self.item(title="새 품목"), token)[0], 200)
        with patch.object(keep, "send") as send:
            self.assertTrue(keep.flush())
            self.assertFalse(keep.flush())
            send.assert_not_called()
        with patch.object(other, "send", return_value=[{"1": "new-account-note"}]) as send:
            self.assertTrue(other.flush())
            self.assertEqual(send.call_args.args[0][0]["item"]["title"], "새 품목")

    def test_cors_preflight_validation_and_private_files(self):
        token = self.login()
        origin = "https://ssoommproject.github.io"
        code, _, headers = self.request("/api/data", "OPTIONS", origin=origin)
        self.assertEqual(code, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.request("/api/data", token=token, origin="https://untrusted.example")[0], 403)
        for path in ("/server.py", "/ai.py", "/ai-config.json", "/antigravity-config.json", "/.git/config", "/somhouse.sqlite3", "/initial-accounts.txt", "/../server.py"):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/api/items/shopping/a", "PUT", self.item("mismatch"), token)[0], 400)

    def test_login_rate_limit(self):
        for _ in range(10):
            self.assertEqual(self.request("/api/login", "POST", {"username": "nobody", "password": "wrong"})[0], 401)
        code, _, headers = self.request("/api/login", "POST", {"username": "family1", "password": "test-password-1"})
        self.assertEqual(code, 429)
        self.assertEqual(headers["Retry-After"], "60")

    def connect_ai(self, kind, allow_summaries=False):
        provider = kind(self.store.directory, Path(sys.executable), allow_summaries)
        providers = self.server.ai.providers
        self.addCleanup(providers.__setitem__, kind.id, providers[kind.id])
        providers[kind.id] = provider
        return provider

    def antigravity(self, allow_summaries=False):
        return self.connect_ai(Antigravity, allow_summaries)

    def test_ai_configuration_requires_a_private_file_and_login(self):
        from ai import Assistants
        self.assertEqual(self.request("/api/ai")[0], 401)
        token = self.login()
        code, status, _ = self.request("/api/ai", token=token)
        self.assertEqual(code, 200)
        self.assertFalse(status["enabled"])
        self.assertEqual([(p["id"], p["enabled"]) for p in status["providers"]],
                         [("codex", False), ("claude", False), ("antigravity", False)])
        self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕"}, token)[0], 503)
        self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕", "provider": "claude"}, token)[0], 503)
        path = self.store.directory / CONFIG_NAME
        self.addCleanup(path.unlink, missing_ok=True)
        save_config(self.store.directory, "claude", Path(sys.executable), False, "haiku")
        save_config(self.store.directory, "codex", Path(sys.executable), True)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with patch("ai.SANDBOX", Path(sys.executable)):
            status = {p["id"]: p for p in Assistants.load(self.store.directory).status()}
            self.assertEqual(status["claude"], {"id": "claude", "name": "Claude", "company": "Anthropic",
                                                "enabled": True, "model": "haiku", "recordSummaries": False})
            self.assertEqual((status["codex"]["enabled"], status["codex"]["recordSummaries"], status["codex"]["model"]),
                             (True, True, None))
            self.assertFalse(status["antigravity"]["enabled"])
            # Connecting one AI keeps the others; disconnecting removes only that one.
            self.assertTrue(remove_config(self.store.directory, "codex"))
            self.assertFalse(remove_config(self.store.directory, "codex"))
            status = {p["id"]: p["enabled"] for p in Assistants.load(self.store.directory).status()}
            self.assertEqual(status, {"codex": False, "claude": True, "antigravity": False})
            path.chmod(0o644)
            self.assertFalse(any(p["enabled"] for p in Assistants.load(self.store.directory).status()))
        # Without the macOS sandbox no CLI is offered.
        path.chmod(0o600)
        with patch("ai.SANDBOX", self.store.directory / "missing"):
            self.assertFalse(any(p["enabled"] for p in Assistants.load(self.store.directory).status()))

    def test_ai_keeps_an_antigravity_setup_saved_by_the_previous_version(self):
        from ai import Assistants
        legacy = self.store.directory / LEGACY_CONFIG_NAME
        legacy.write_text(json.dumps({"binary": sys.executable, "allowRecordSummaries": True}), encoding="utf-8")
        legacy.chmod(0o600)
        self.addCleanup(legacy.unlink, missing_ok=True)
        self.addCleanup((self.store.directory / CONFIG_NAME).unlink, missing_ok=True)
        with patch("ai.SANDBOX", Path(sys.executable)):
            provider = Assistants.load(self.store.directory).providers["antigravity"]
            self.assertEqual((provider.binary, provider.allow_summaries), (Path(sys.executable), True))
            save_config(self.store.directory, "claude", Path(sys.executable), False)
            self.assertFalse(legacy.exists())
            status = {p["id"]: p["enabled"] for p in Assistants.load(self.store.directory).status()}
            self.assertEqual(status, {"codex": False, "claude": True, "antigravity": True})

    def test_ai_asks_the_chosen_provider_and_rejects_unconnected_ones(self):
        token = self.login()
        codex, claude = self.connect_ai(Codex), self.connect_ai(Claude)
        codex_fixture = """
import json, sys
assert sys.argv == ["-c"]
prompt = sys.stdin.read()
question = json.loads(prompt.splitlines()[-1])["question"]
print(json.dumps({"type": "thread.started"}))
print(json.dumps({"type": "item.completed", "item": {"type": "reasoning", "text": "thinking"}}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "codex: " + question}}))
print(json.dumps({"type": "turn.completed"}))
"""
        claude_fixture = """
import json, sys
question = json.loads(sys.stdin.read())["question"]
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "claude: " + question}))
"""
        with patch.object(codex, "command", return_value=[sys.executable, "-c", codex_fixture]), \
                patch.object(claude, "command", return_value=[sys.executable, "-c", claude_fixture]):
            code, status, _ = self.request("/api/ai", token=token)
            self.assertTrue(status["enabled"])
            self.assertEqual({p["id"]: p["enabled"] for p in status["providers"]},
                             {"codex": True, "claude": True, "antigravity": False})
            for name in ("codex", "claude"):
                code, result, _ = self.request("/api/ai", "POST", {"question": "안녕", "provider": name}, token)
                self.assertEqual((code, result["answer"], result["provider"]), (200, f"{name}: 안녕", name))
            # Without a choice the first connected AI answers.
            self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕"}, token)[1]["provider"], "codex")
            code, result, _ = self.request("/api/ai", "POST", {"question": "안녕", "provider": "antigravity"}, token)
            self.assertEqual(code, 503)
            self.assertIn("Antigravity", result["error"])
            for name in ("gpt", 3, ["codex"]):
                self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕", "provider": name}, token)[0], 400)
            # Record summaries are allowed per AI.
            self.assertEqual(self.request("/api/ai", "POST", {"question": "요약", "scope": "feeding", "provider": "claude"}, token)[0], 403)
        self.server.ai.attempts.clear()

    def test_codex_and_claude_errors_are_explained_without_the_question(self):
        token = self.login()
        codex, claude = self.connect_ai(Codex), self.connect_ai(Claude)
        codex_fixture = """
import json, sys
question = json.loads(sys.stdin.read().splitlines()[-1])["question"]
messages = {"로그인": "401 Unauthorized: PRIVATE-PROVIDER-ERROR", "한도": "You've hit your usage limit.",
            "모델": "The 'm' model is not supported when using Codex with a ChatGPT account."}
print(json.dumps({"type": "error", "message": "Reconnecting... 1/5 " + question}))
print(json.dumps({"type": "turn.failed", "error": {"message": messages.get(question, "unknown")}}))
sys.exit(1)
"""
        claude_fixture = """
import json, sys
question = json.loads(sys.stdin.read())["question"]
messages = {"로그인": "Not logged in · Please run /login", "한도": "Claude AI usage limit reached",
            "모델": "There's an issue with the selected model (m)."}
print(json.dumps({"type": "result", "subtype": "success", "is_error": True, "result": messages.get(question, "unknown")}))
sys.exit(1)
"""
        log = io.StringIO()
        with patch.object(codex, "command", return_value=[sys.executable, "-c", codex_fixture]), \
                patch.object(claude, "command", return_value=[sys.executable, "-c", claude_fixture]), \
                patch("ai.sys.stderr", log):
            for name in ("codex", "claude"):
                for question, status, text in (("한도", 429, "한도"), ("오류", 502, "답변을 받지 못했어요"),
                                               ("로그인", 503, "로그인"), ("모델", 503, "모델을 사용할 수 없어요")):
                    code, result, _ = self.request("/api/ai", "POST", {"question": question, "provider": name}, token)
                    self.assertEqual(code, status, (name, question, result))
                    self.assertIn(text, result["error"])
                    self.assertNotIn("PRIVATE-PROVIDER-ERROR", json.dumps(result))
                    self.server.ai.attempts.clear()
        lines = log.getvalue().splitlines()
        self.assertEqual(len(lines), 8)
        self.assertTrue(lines[0].startswith("codex: status=429 exit=1"))
        self.assertTrue(lines[4].startswith("claude: status=429 exit=1"))
        self.assertIn("PRIVATE-PROVIDER-ERROR", lines[2])
        for line in lines:
            for question in ("한도", "오류", "로그인", "모델"):
                self.assertNotIn(question, line)

    def test_codex_and_claude_commands_turn_off_tools_and_keep_the_question_out_of_arguments(self):
        workspace = Path("/tmp/somhouse-workspace")
        codex = Codex(self.store.directory, Path("/usr/bin/true")).command(workspace)
        self.assertEqual(codex[:2], ["/usr/bin/sandbox-exec", "-p"])
        for flag in ("--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json"):
            self.assertIn(flag, codex)
        self.assertEqual(codex[codex.index("--sandbox") + 1], "read-only")
        disabled = {codex[index + 1] for index, value in enumerate(codex) if value == "--disable"}
        self.assertLessEqual({"shell_tool", "unified_exec", "plugins", "apps", "browser_use", "computer_use", "multi_agent"}, disabled)
        self.assertIn('web_search="disabled"', codex)
        self.assertNotIn("--model", codex)
        self.assertEqual(codex[-1], "-")
        self.assertIn("--model", Codex(self.store.directory, Path("/usr/bin/true"), model="gpt-x").command(workspace))
        claude = Claude(self.store.directory, Path("/usr/bin/true")).command(workspace)
        self.assertEqual(claude[claude.index("--tools") + 1], "")
        self.assertEqual(claude[claude.index("--setting-sources") + 1], "")
        self.assertEqual(claude[claude.index("--model") + 1], "sonnet")
        for flag in ("--print", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"):
            self.assertIn(flag, claude)
        for kind, profile, names in ((Codex, ".codex", ("AGENTS.md", "config.toml", "skills", "memories")),
                                     (Claude, ".claude", ("CLAUDE.md", "settings.json", "skills", "projects"))):
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CODEX_HOME", None)
                os.environ.pop("CLAUDE_CONFIG_DIR", None)
                policy = kind(self.store.directory, Path("/usr/bin/true")).policy()
            for name in names:
                self.assertIn(json.dumps(str((Path.home() / profile).resolve() / name)), policy)
            self.assertIn(json.dumps(str(self.store.directory.resolve())), policy)

    @unittest.skipUnless(sys.platform == "darwin", "requires the macOS sandbox")
    def test_codex_and_claude_processes_cannot_access_family_files_or_their_customizations(self):
        secret = self.store.directory / "ai-test-private.txt"
        secret.write_text("private", encoding="utf-8")
        self.addCleanup(secret.unlink)
        for kind, profile, custom_name, output in (
                (Codex, ".codex", "AGENTS.md",
                 '{"type": "item.completed", "item": {"type": "agent_message", "text": "blocked"}}\n{"type": "turn.completed"}'),
                (Claude, ".claude", "CLAUDE.md",
                 '{"type": "result", "subtype": "success", "is_error": false, "result": "blocked"}')):
            with tempfile.TemporaryDirectory() as directory:
                home = Path(directory).resolve()
                (home / profile).mkdir()
                custom = home / profile / custom_name
                custom.write_text("private customization", encoding="utf-8")
                login = home / profile / "auth.json"
                login.write_text("login", encoding="utf-8")
                binary = home / "cli-fixture"
                binary.write_text(f"""#!{sys.executable}
import os, pathlib, sys
assert "OPENAI_API_KEY" not in os.environ and "ANTHROPIC_API_KEY" not in os.environ
private = pathlib.Path({str(secret)!r})
custom = pathlib.Path({str(custom)!r})
login = pathlib.Path({str(login)!r})
assert login.read_text() == "login"
login.write_text("refreshed")
for action in (private.read_text, lambda: private.write_text("changed"), custom.read_text):
    try:
        action()
    except PermissionError:
        pass
    else:
        raise AssertionError("a blocked path was accessible")
sys.stdin.read()
print({output!r})
""", encoding="utf-8")
                binary.chmod(0o700)
                provider = kind(self.store.directory, binary)
                environment = {"OPENAI_API_KEY": "test-secret", "ANTHROPIC_API_KEY": "test-secret"}
                with patch("ai.Path.home", return_value=home), patch.dict(os.environ, environment):
                    os.environ.pop("CODEX_HOME", None)
                    os.environ.pop("CLAUDE_CONFIG_DIR", None)
                    self.assertEqual(provider.generate("권한 확인", "none", None)["answer"], "blocked")
                self.assertEqual(login.read_text(encoding="utf-8"), "refreshed")
            self.assertEqual(secret.read_text(encoding="utf-8"), "private")

    def test_antigravity_sends_only_the_selected_record_summary_to_stdin(self):
        from datetime import date
        token = self.login()
        provider = self.antigravity(allow_summaries=True)
        today = date.today().isoformat()
        private_note = "PRIVATE-NOTE-DO-NOT-SEND"
        items = [
            {"id": "feed-1", "type": "feeding", "date": today+"T12:00", "category": "분유", "amount": "80ml", "memo": private_note},
            {"id": "feed-2", "type": "feeding", "date": today+"T13:00", "category": "모유", "amount": "10분", "memo": private_note},
            {"id": "hospital-1", "type": "hospital", "date": today+"T14:00", "hospital": "PRIVATE-HOSPITAL", "reason": private_note},
        ]
        for item in items:
            self.request("/api/items/records/"+item["id"], "PUT", item, token)
        # A separate process echoes the parsed input and ensures it wasn't
        # passed via arguments, an inherited key or the working directory.
        fixture = """
import json, os, pathlib, sys
assert len(sys.argv) == 1 and "GEMINI_API_KEY" not in os.environ
assert not list(pathlib.Path.cwd().iterdir())
message = json.load(sys.stdin)
assert message["event"] == "user"
context = message["message"]["content"].splitlines()[-1]
print(json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": context}}))
"""
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-secret"}), \
                patch.object(provider, "command", return_value=[sys.executable, "-c", fixture]):
            code, result, _ = self.request("/api/ai", "POST", {"question": "안녕"}, token)
            self.assertEqual(code, 200, result)
            self.assertEqual(json.loads(result["answer"]), {"question": "안녕"})
            code, result, _ = self.request("/api/ai", "POST", {"question": "수유 요약", "scope": "feeding"}, token)
            self.assertEqual(code, 200, result)
            payload = json.loads(result["answer"])
            self.assertEqual(payload["records"]["summary"][today],
                             {"count": 2, "measured_count": 1, "volume_ml": 80.0})
            self.assertNotIn(private_note, result["answer"])
            self.assertNotIn("PRIVATE-HOSPITAL", result["answer"])
        with self.store.connect() as db:
            self.assertEqual(len(self.store.state(db)["records"]), 3)

    def test_antigravity_limits_and_provider_errors(self):
        token = self.login()
        provider = self.antigravity()
        self.assertEqual(self.request("/api/ai", "POST", {"question": "요약", "scope": "feeding"}, token)[0], 403)
        self.assertEqual(self.request("/api/ai", "POST", {"question": "요약", "scope": "unknown"}, token)[0], 400)
        self.assertEqual(self.request("/api/ai", "POST", {"question": "a"*2001}, token)[0], 400)
        fixture = """
import json, sys
question = json.loads(json.load(sys.stdin)["message"]["content"].splitlines()[-1])["question"]
if question == "로그인":
    sys.stderr.write("authentication required: PRIVATE-PROVIDER-ERROR")
elif question == "모델":
    print("warning: not a JSON line")
    print(json.dumps({"event": "result", "result": {"status": "ERROR", "error":
        'invalid model selection (--model "m" --effort ""): model m is not recognized as a known model or custom model in settings 모델'}}))
else:
    error = "rate limit" if question == "한도" else "unknown error"
    print(json.dumps({"event": "result", "result": {"status": "ERROR", "error": error}}))
sys.exit(1)
"""
        log = io.StringIO()
        with patch.object(provider, "command", return_value=[sys.executable, "-c", fixture]), \
                patch("ai.sys.stderr", log):
            for question, status in (("한도", 429), ("오류", 502), ("로그인", 503), ("모델", 503)):
                code, result, _ = self.request("/api/ai", "POST", {"question": question}, token)
                self.assertEqual(code, status)
                self.assertNotIn("PRIVATE-PROVIDER-ERROR", json.dumps(result))
                self.server.ai.attempts.clear()
        self.assertIn("모델을 사용할 수 없어요", result["error"])
        # The service log explains each failure without repeating the question.
        lines = log.getvalue().splitlines()
        self.assertEqual(len(lines), 4)
        self.assertIn("status=429 exit=1 timed_out=False", lines[0])
        self.assertIn("PRIVATE-PROVIDER-ERROR", lines[2])
        self.assertIn("not recognized as a known model", lines[3])
        self.assertNotIn("모델", lines[3].split("model=", 1)[1].split(" ", 1)[1])
        self.server.ai.active.add("family1")
        self.addCleanup(self.server.ai.active.discard, "family1")
        self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕"}, token)[0], 429)

    def test_antigravity_wait_releases_the_record_database_lock(self):
        token = self.login()
        provider = self.antigravity()

        def generate(*_):
            self.assertEqual(self.request("/api/data", token=token)[0], 200)
            return {"answer": "모의 답변", "truncated": False}

        with patch.object(provider, "generate", side_effect=generate):
            self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕"}, token)[0], 200)

    def test_antigravity_checks_the_session_before_validating_the_question(self):
        self.antigravity()
        for body in ({"question": ""}, {"question": "안녕", "scope": "unknown"}):
            self.assertEqual(self.request("/api/ai", "POST", body, "not-a-session")[0], 401)

    @unittest.skipUnless(sys.platform == "darwin", "requires the macOS sandbox")
    def test_antigravity_process_can_read_only_the_default_project_and_cannot_access_family_files(self):
        secret = self.store.directory / "antigravity-test-private.txt"
        secret.write_text("private", encoding="utf-8")
        self.addCleanup(secret.unlink)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            config = home / ".gemini/config"
            project = config / "projects/default-cli-project.json"
            project.parent.mkdir(parents=True)
            project.write_text("test-project", encoding="utf-8")
            custom = config / "mcp_config.json"
            custom.write_text("private customization", encoding="utf-8")
            binary = home / "agy-fixture"
            binary.write_text(f"""#!{sys.executable}
import json, pathlib, sys
private = pathlib.Path({str(secret)!r})
project = pathlib.Path({str(project)!r})
custom = pathlib.Path({str(custom)!r})
assert project.read_text() == "test-project"
for action in (private.read_text, lambda: private.write_text("changed"),
               custom.read_text, lambda: project.write_text("changed")):
    try:
        action()
    except PermissionError:
        pass
    else:
        raise AssertionError("a blocked path was accessible")
settings = json.loads(sys.argv[sys.argv.index("--settings") + 1])
assert {{"command(*)", "read_file(*)", "write_file(*)", "mcp(*)"}} <= set(settings["permissions"]["deny"])
print(json.dumps({{"event": "result", "result": {{"status": "SUCCESS", "response": "blocked"}}}}))
""", encoding="utf-8")
            binary.chmod(0o700)
            provider = Antigravity(self.store.directory, binary)
            with patch("ai.Path.home", return_value=home):
                self.assertEqual(provider.generate("권한 확인", "none", None)["answer"], "blocked")
            self.assertEqual(secret.read_text(encoding="utf-8"), "private")
            self.assertEqual(project.read_text(encoding="utf-8"), "test-project")

    def test_antigravity_sandbox_blocks_the_global_cli_settings(self):
        policy = Antigravity(self.store.directory, Path(sys.executable)).command(Path("/tmp/w"))[2]
        blocked = policy.split("(deny file-read* file-write* ", 1)[1].split("))", 1)[0]
        for name in ("settings.json", "antigravity-cli/settings.json", "antigravity-cli/mcp_config.json"):
            self.assertIn(json.dumps(str((Path.home() / ".gemini").resolve() / name)), blocked)

    def test_antigravity_deadline_stops_the_process_and_releases_the_slot(self):
        token = self.login()
        provider = self.antigravity()
        log = io.StringIO()
        with patch("ai.DEADLINE_SECONDS", 0.2), patch("ai.EXIT_GRACE_SECONDS", 0.2), \
                patch("ai.sys.stderr", log), \
                patch.object(provider, "command", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]):
            started = time.monotonic()
            code, _, _ = self.request("/api/ai", "POST", {"question": "안녕"}, token)
            self.assertEqual(code, 504)
            self.assertLess(time.monotonic() - started, 2)
        self.assertNotIn("family1", self.server.ai.active)
        self.assertIn("status=504", log.getvalue())
        self.assertIn("timed_out=True", log.getvalue())

    def test_antigravity_keeps_an_answer_from_a_process_that_exits_late(self):
        token = self.login()
        provider = self.antigravity()
        fixture = """
import json, sys, time
sys.stdin.read()
print(json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": "늦은 종료"}}), flush=True)
time.sleep(30)
"""
        with patch("ai.DEADLINE_SECONDS", 0.5), patch("ai.EXIT_GRACE_SECONDS", 0.5), \
                patch.object(provider, "command", return_value=[sys.executable, "-c", fixture]):
            code, result, _ = self.request("/api/ai", "POST", {"question": "안녕"}, token)
        self.assertEqual((code, result.get("answer")), (200, "늦은 종료"))


if __name__ == "__main__":
    unittest.main()


class SleepDiaperSummaryTest(unittest.TestCase):
    def test_scopes_accepted_and_summarized(self):
        import ai
        from datetime import date
        self.assertEqual(ai.parse_question({"question": "잠", "scope": "sleep"}), ("잠", "sleep"))
        self.assertEqual(ai.parse_question({"question": "기저귀", "scope": "diaper"}), ("기저귀", "diaper"))
        items = [{"type": "sleep", "date": "2026-11-20T09:00", "end": "2026-11-20T10:30"},
                 {"type": "diaper", "date": "2026-11-20T09:00", "category": "대변"}]
        self.assertEqual(ai.summarize_records("sleep", items, date(2026, 11, 20))["2026-11-20"], {"count": 1, "minutes": 90})
        self.assertEqual(ai.summarize_records("diaper", items, date(2026, 11, 20))["2026-11-20"], {"count": 1, "pee": 0, "poo": 1})
        self.assertEqual(len(ai.summarize_records("sleep", items, date(2026, 11, 20))), 7)
