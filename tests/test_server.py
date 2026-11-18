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
from antigravity import CONFIG_NAME, MODEL, Antigravity, save_config
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
        self.assertEqual(self.request("/api/me", token=guest)[1], {"username": "guest", "read_only": True})
        code, view, _ = self.request("/api/data", token=guest)
        self.assertEqual(code, 200)
        self.assertTrue(view["read_only"])
        self.assertNotIn("실제병원", json.dumps(view, ensure_ascii=False))
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
        for path in ("/server.py", "/antigravity.py", "/antigravity-config.json", "/.git/config", "/somhouse.sqlite3", "/initial-accounts.txt", "/../server.py"):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/api/items/shopping/a", "PUT", self.item("mismatch"), token)[0], 400)

    def test_login_rate_limit(self):
        for _ in range(10):
            self.assertEqual(self.request("/api/login", "POST", {"username": "nobody", "password": "wrong"})[0], 401)
        code, _, headers = self.request("/api/login", "POST", {"username": "family1", "password": "test-password-1"})
        self.assertEqual(code, 429)
        self.assertEqual(headers["Retry-After"], "60")

    def antigravity(self, allow_summaries=False):
        provider = Antigravity(self.store.directory, Path(sys.executable), allow_summaries)
        original = self.server.antigravity
        self.addCleanup(setattr, self.server, "antigravity", original)
        self.server.antigravity = provider
        return provider

    def test_antigravity_configuration_requires_a_private_file_and_login(self):
        self.assertEqual(self.request("/api/ai")[0], 401)
        token = self.login()
        self.assertFalse(self.request("/api/ai", token=token)[1]["enabled"])
        self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕"}, token)[0], 503)
        path = self.store.directory / CONFIG_NAME
        self.addCleanup(path.unlink)
        save_config(self.store.directory, Path(sys.executable), False)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with patch("antigravity.SANDBOX", Path(sys.executable)):
            self.assertEqual(Antigravity.load(self.store.directory).status(),
                             {"enabled": True, "model": MODEL, "recordSummaries": False})
            path.chmod(0o644)
            self.assertFalse(Antigravity.load(self.store.directory).status()["enabled"])

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
                patch("antigravity.sys.stderr", log):
            for question, status in (("한도", 429), ("오류", 502), ("로그인", 503), ("모델", 503)):
                code, result, _ = self.request("/api/ai", "POST", {"question": question}, token)
                self.assertEqual(code, status)
                self.assertNotIn("PRIVATE-PROVIDER-ERROR", json.dumps(result))
                provider.attempts.clear()
        self.assertIn("모델을 사용할 수 없어요", result["error"])
        # The service log explains each failure without repeating the question.
        lines = log.getvalue().splitlines()
        self.assertEqual(len(lines), 4)
        self.assertIn("status=429 exit=1 timed_out=False", lines[0])
        self.assertIn("PRIVATE-PROVIDER-ERROR", lines[2])
        self.assertIn("not recognized as a known model", lines[3])
        self.assertNotIn("모델", lines[3].split("model=", 1)[1].split(" ", 1)[1])
        provider.active.add("family1")
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
            with patch("antigravity.Path.home", return_value=home):
                self.assertEqual(provider.generate("권한 확인", "none", None)["answer"], "blocked")
            self.assertEqual(secret.read_text(encoding="utf-8"), "private")
            self.assertEqual(project.read_text(encoding="utf-8"), "test-project")

    def test_antigravity_sandbox_blocks_the_global_cli_settings(self):
        policy = Antigravity(self.store.directory, Path(sys.executable)).command(Path("agy.log"))[2]
        blocked = policy.split("(deny file-read* file-write* ", 1)[1].split("))", 1)[0]
        for name in ("settings.json", "antigravity-cli/settings.json", "antigravity-cli/mcp_config.json"):
            self.assertIn(json.dumps(str((Path.home() / ".gemini").resolve() / name)), blocked)

    def test_antigravity_deadline_stops_the_process_and_releases_the_slot(self):
        token = self.login()
        provider = self.antigravity()
        log = io.StringIO()
        with patch("antigravity.DEADLINE_SECONDS", 0.2), patch("antigravity.EXIT_GRACE_SECONDS", 0.2), \
                patch("antigravity.sys.stderr", log), \
                patch.object(provider, "command", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]):
            started = time.monotonic()
            code, _, _ = self.request("/api/ai", "POST", {"question": "안녕"}, token)
            self.assertEqual(code, 504)
            self.assertLess(time.monotonic() - started, 2)
        self.assertNotIn("family1", provider.active)
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
        with patch("antigravity.DEADLINE_SECONDS", 0.5), patch("antigravity.EXIT_GRACE_SECONDS", 0.5), \
                patch.object(provider, "command", return_value=[sys.executable, "-c", fixture]):
            code, result, _ = self.request("/api/ai", "POST", {"question": "안녕"}, token)
        self.assertEqual((code, result.get("answer")), (200, "늦은 종료"))


if __name__ == "__main__":
    unittest.main()
