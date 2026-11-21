"""Optional-feature files and family-shared items: who can read and write them, and that backups keep them."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_families
import server as server_module
from server import FamilyServer, MAX_FEATURE_ITEM, Store


class FeatureItems(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="somhouse-features-")
        self.store = Store(self.temp.name)
        self.store.password("family1", "test-password-1")
        self.store.password("family2", "test-password-2")
        self.store.password("guest", "guest-password-1")
        self.server = FamilyServer(("127.0.0.1", 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method="GET", body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = None if body is None else json.dumps(body).encode()
        try:
            with urlopen(Request(f"http://127.0.0.1:{self.server.server_port}{path}", data, headers, method=method)) as r:
                raw = r.read()
                return r.status, json.loads(raw) if r.headers.get_content_type() == "application/json" else raw
        except HTTPError as error:
            with error:
                return error.code, error.read()

    def login(self, name="family1", password="test-password-1"):
        return self.request("/api/login", "POST", {"username": name, "password": password})[1]["token"]

    def put(self, token, feature="meds", item=None):
        return self.request("/api/feature-data", "POST", {"feature": feature, "action": "put", "item": item or {"id": "a", "name": "해열제"}}, token)

    def test_nothing_changes_for_a_family_that_uses_no_feature(self):
        settings = self.request("/api/data", token=self.login())[1]["settings"]
        self.assertNotIn("features", settings)

    def test_items_are_shared_within_the_family_and_removed_one_by_one(self):
        one, two = self.login(), self.login("family2", "test-password-2")
        self.assertEqual(self.put(one)[0], 200)
        self.assertEqual(self.put(two, item={"id": "b", "name": "유산균"})[0], 200)
        seen = self.request("/api/data", token=one)[1]["settings"]["features"]["meds"]
        self.assertEqual([x["id"] for x in seen], ["a", "b"])
        self.assertEqual(self.put(one, item={"id": "a", "name": "해열제 시럽"})[0], 200)
        seen = self.request("/api/data", token=two)[1]["settings"]["features"]["meds"]
        self.assertEqual(seen[0]["name"], "해열제 시럽")
        self.assertEqual(self.request("/api/feature-data", "POST", {"feature": "meds", "action": "delete", "item": {"id": "a"}}, two)[0], 200)
        self.assertEqual(self.request("/api/feature-data", "POST", {"feature": "meds", "action": "delete", "item": {"id": "b"}}, two)[0], 200)
        self.assertNotIn("features", self.request("/api/data", token=one)[1]["settings"])

    def test_bad_requests_and_the_guest_are_refused(self):
        token = self.login()
        for body in ({"feature": "nope", "action": "put", "item": {"id": "a"}}, {"feature": "meds", "action": "wipe", "item": {"id": "a"}},
                     {"feature": "meds", "action": "put", "item": {"name": "no id"}}, {"feature": "meds", "action": "put", "item": []},
                     {"feature": "meds", "action": "put", "item": {"id": "x" * 201}},
                     {"feature": "meds", "action": "put", "item": {"id": "big", "text": "x" * MAX_FEATURE_ITEM}}):
            self.assertEqual(self.request("/api/feature-data", "POST", body, token)[0], 400, body.get("action"))
        self.assertEqual(self.put(None)[0], 401)
        self.assertEqual(self.put(self.login("guest", "guest-password-1"))[0], 403)
        self.assertNotIn("features", self.request("/api/data", token=token)[1]["settings"])

    def test_the_item_limit_allows_edits_but_not_new_items(self):
        token = self.login()
        original, server_module.MAX_FEATURE_ITEMS = server_module.MAX_FEATURE_ITEMS, 1
        try:
            self.assertEqual(self.put(token)[0], 200)
            self.assertEqual(self.put(token, item={"id": "a", "name": "수정"})[0], 200)
            self.assertEqual(self.put(token, item={"id": "b"})[0], 409)
        finally:
            server_module.MAX_FEATURE_ITEMS = original

    def test_backups_keep_feature_items_and_only_an_admin_restore_writes_them(self):
        token = self.login()
        self.put(token)
        with self.store.lock, self.store.connect() as db:
            path = self.store.snapshot(db, automatic=False)
        saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["feature_items"]["meds"][0]["name"], "해열제")
        self.request("/api/feature-data", "POST", {"feature": "meds", "action": "delete", "item": {"id": "a"}}, token)
        self.request("/api/merge", "POST", saved, token)
        self.assertNotIn("features", self.request("/api/data", token=token)[1]["settings"], "a browser merge must not write them")
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "server.py"), "restore", "--data-dir", self.temp.name, "--file", str(path)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.request("/api/data", token=token)[1]["settings"]["features"]["meds"][0]["name"], "해열제")
        again = subprocess.run(command, capture_output=True, text=True)
        self.assertIn("0개 추가", again.stdout)

    def test_a_backup_with_bad_feature_items_changes_nothing(self):
        token = self.login()
        self.put(token)
        bad = Path(self.temp.name) / "bad.json"
        bad.write_text(json.dumps({"records": [], "schedule": [], "shopping": [], "feature_items": {"nope": [{"id": "x"}]}}), encoding="utf-8")
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "server.py"), "restore", "--data-dir", self.temp.name, "--file", str(bad)]
        self.assertNotEqual(subprocess.run(command, capture_output=True, text=True).returncode, 0)
        self.assertEqual(len(self.request("/api/data", token=token)[1]["settings"]["features"]["meds"]), 1)

    def test_only_feature_files_are_served(self):
        status, body = self.request("/features.js")
        self.assertEqual(status, 200)
        self.assertIn(b"SOMHOUSE_FEATURES", body)
        for path in ("/features/not-there.js", "/sw-other.js", "/features/../server.py", "/features/x.py", "/features/%2e%2e/server.py"):
            self.assertEqual(self.request(path)[0], 404, path)


class FamilySeparation(unittest.TestCase):
    setUp = test_families.Families.setUp
    tearDown = test_families.Families.tearDown
    request = test_families.Families.request
    google = test_families.Families.google

    def test_another_family_never_sees_these_items(self):
        ours = self.request("/api/login", "POST", {"username": "family1", "password": "test-password-1"})[1]["token"]
        theirs = self.google("OTHER", "other@example.com")["token"]
        self.assertEqual(self.request("/api/feature-data", "POST", {"feature": "meds", "action": "put", "item": {"id": "a", "name": "우리 약"}}, ours)[0], 200)
        self.assertNotIn("features", self.request("/api/data", token=theirs)[1]["settings"])
        self.assertEqual(self.request("/api/feature-data", "POST", {"feature": "meds", "action": "delete", "item": {"id": "a"}}, theirs)[0], 200)
        self.assertEqual(len(self.request("/api/data", token=ours)[1]["settings"]["features"]["meds"]), 1)


if __name__ == "__main__":
    unittest.main()
