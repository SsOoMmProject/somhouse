"""Exercise the actual HTTP API against an isolated temporary database."""
import hashlib
import json
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
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import FamilyServer, Store


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
            for table in ("items", "imports", "sessions"):
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

    def test_cors_preflight_validation_and_private_files(self):
        token = self.login()
        origin = "https://ssoommproject.github.io"
        code, _, headers = self.request("/api/data", "OPTIONS", origin=origin)
        self.assertEqual(code, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.request("/api/data", token=token, origin="https://untrusted.example")[0], 403)
        for path in ("/server.py", "/.git/config", "/somhouse.sqlite3", "/initial-accounts.txt", "/../server.py"):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/api/items/shopping/a", "PUT", self.item("mismatch"), token)[0], 400)

    def test_login_rate_limit(self):
        for _ in range(10):
            self.assertEqual(self.request("/api/login", "POST", {"username": "nobody", "password": "wrong"})[0], 401)
        code, _, headers = self.request("/api/login", "POST", {"username": "family1", "password": "test-password-1"})
        self.assertEqual(code, 429)
        self.assertEqual(headers["Retry-After"], "60")


if __name__ == "__main__":
    unittest.main()
