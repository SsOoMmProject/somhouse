"""Families see only their own records: sign-in routing, invites, pre-registered addresses, removal."""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import unquote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import google_web
import chatgpt_plan
from google_records import save_config
from server import FamilyServer, Store

BACK = "https://ssoommproject.github.io/somhouse/"


class Families(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="somhouse-families-")
        self.directory = Path(self.temp.name)
        self.store = Store(self.directory)
        self.store.password("family1", "test-password-1")
        client = self.directory / "client.json"
        client.write_text(json.dumps({"web": {"client_id": "web-id", "client_secret": "web-secret",
                                              "redirect_uris": ["https://family.example/api/google/callback"]}}))
        google_web.save_web_client(self.directory, client, "https://family.example")
        save_config(self.directory, {"subject": "HOME", "binding": "b"})
        os.chmod(self.directory / "google-records.json", 0o600)
        self.server = FamilyServer(("127.0.0.1", 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.who = {}

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
                return r.status, json.loads(r.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def google(self, sub, email, invite=None):
        """Sign in through the real start → callback → one-time code flow. Returns the login or the error."""
        body = {"mode": "login", "returnTo": BACK}
        if invite:
            body["invite"] = invite
        with patch.object(google_web, "exchange", lambda *a: {"access_token": "at"}), \
             patch.object(google_web, "identity", lambda token: {"sub": sub, "email": email, "email_verified": True}):
            url = self.request("/api/google/start", "POST", body)[1]["url"]
            state = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))["state"]
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
            connection.request("GET", f"/api/google/callback?state={state}&code=abc")
            response = connection.getresponse(); response.read(); connection.close()
        location = response.getheader("Location")
        if "#google-error=" in location:
            return {"error": unquote(location.split("#google-error=")[1])}
        return self.request("/api/login/google", "POST", {"code": location.split("#google=")[1]})[1]

    def save(self, token, item_id, amount):
        item = {"id": item_id, "type": "feeding", "date": "2026-11-20T09:00", "category": "분유", "amount": amount}
        return self.request(f"/api/items/records/{item_id}", "PUT", item, token)

    def records(self, token):
        code, body = self.request("/api/data", token=token)
        return [x["id"] for x in body["data"]["records"]] if code == 200 else code

    def test_chatgpt_only_serves_the_personal_session_in_each_family(self):
        home = self.google("HOME", "home@example.com")["token"]
        other = self.google("OTHER", "other@example.com")["token"]
        second_device = self.google("OTHER", "other@example.com")["token"]
        other_store = self.server.family_for(other).store
        self.assertNotIn("chatgptPlan", self.request("/api/ai", token=home)[1])
        self.assertEqual(self.request("/api/chatgpt/start", "POST", {}, home)[0], 503)
        with patch.object(self.server, "chatgpt") as service:
            service.redirect = "https://somhouse.example/auth/openai/callback"
            service.ask.return_value = {"answer": "시험 답변"}
            chatgpt_plan.save(other_store, other, {"email": "mine@example.com", "model": "my-model", "refresh": "SECRET"})
            status = self.request("/api/ai", token=other)[1]["chatgptPlan"]
            self.assertEqual(status, {"connected": True, "email": "mine@example.com", "model": "my-model"})
            for token in (home, second_device):
                self.assertFalse(self.request("/api/ai", token=token)[1]["chatgptPlan"]["connected"])
            self.assertEqual(self.request("/api/chatgpt/ask", "POST", {"question": "hi", "scope": "feeding"}, other)[0], 400)
            self.assertEqual(self.request("/api/chatgpt/ask", "POST", {"question": "hi", "scope": "none"}, other),
                             (200, {"answer": "시험 답변"}))
            service.ask.assert_called_once_with(other_store, other, "hi")
            with self.store.connect() as db:
                guest = self.store.new_session(db, "guest")
            self.assertNotIn("chatgptPlan", self.request("/api/ai", token=guest)[1])
            self.assertEqual(self.request("/api/chatgpt/start", "POST", {}, guest)[0], 403)
            self.assertEqual(self.request("/api/chatgpt/start", "POST", {})[0], 401)
            service.revoke.return_value = True
            self.assertEqual(self.request("/api/logout", "POST", {}, other)[0], 200)
            service.revoke.assert_called_once()
            with other_store.connect() as db:
                self.assertFalse(chatgpt_plan.profile(db, chatgpt_plan.session_key(other)))

    def test_each_family_sees_only_its_own_records(self):
        home = self.google("HOME", "somsom@gmail.com")
        self.assertEqual((home["username"], home["family"]["home"], home["outcome"]), ("family", True, "home"))
        self.save(home["token"], "home-1", "100ml")
        password = self.request("/api/login", "POST", {"username": "family1", "password": "test-password-1"})[1]
        self.assertEqual(self.records(password["token"]), ["home-1"])  # password accounts stay in the home family

        # A stranger gets a new, empty family of their own and the two never see each other's records.
        other = self.google("S2", "Other@Gmail.com")
        self.assertEqual((other["username"], other["outcome"], other["family"]["home"]), ("other@gmail.com", "created", False))
        self.assertTrue(other["token"].startswith("f-"))
        self.assertEqual(self.records(other["token"]), [])
        self.save(other["token"], "other-1", "80ml")
        self.assertEqual(self.records(other["token"]), ["other-1"])
        self.assertEqual(self.records(home["token"]), ["home-1"])
        family_id = other["token"][2:18]
        self.assertTrue((self.directory / "families" / family_id / "somhouse.sqlite3").is_file())
        # Signing in again opens the same family.
        self.assertEqual(self.google("S2", "other@gmail.com")["outcome"], "member")

        # A forged or unknown family prefix is not a session.
        self.assertEqual(self.request("/api/data", token="f-0123456789abcdef." + other["token"][19:])[0], 401)
        self.assertEqual(self.request("/api/data", token="f-nothex." + other["token"][19:])[0], 401)

        # The new family has no Google bridge, AI or old-device import; holidays still come from the home feed.
        self.assertEqual(self.request("/api/merge", "POST", {"records": [], "schedule": [], "shopping": []}, other["token"])[0], 403)
        self.assertEqual(self.request("/api/ai", token=other["token"])[1]["enabled"], False)
        self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕"}, other["token"])[0], 403)
        # The Mac's AI answers only the home family; others see every card unconnected and use their own keys.
        from ai import Claude
        self.server.ai.providers["claude"] = Claude(self.store.directory, Path(sys.executable))
        status = self.request("/api/ai", token=other["token"])[1]
        self.assertTrue(status["homeOnly"])
        self.assertEqual([(p["id"], p["enabled"]) for p in status["providers"]],
                         [("codex", False), ("claude", False), ("antigravity", False)])
        self.assertEqual(self.request("/api/ai", "POST", {"question": "안녕", "provider": "claude"}, other["token"])[0], 403)
        self.assertEqual(self.request("/api/family", token=other["token"])[1]["google"]["connected"], False)
        self.assertEqual(self.request("/api/password", "POST", {"currentPassword": "x", "newPassword": "y" * 12}, other["token"])[0], 403)
        self.assertEqual(self.request("/api/me", token=other["token"])[1]["family"]["home"], False)

    def test_pre_registered_address_and_invite_link_join_a_family(self):
        home = self.google("HOME", "somsom@gmail.com")["token"]
        self.save(home, "home-1", "100ml")
        self.assertEqual(self.request("/api/family", "POST", {"action": "add_email", "email": "bad"}, home)[0], 400)
        code, view = self.request("/api/family", "POST", {"action": "add_email", "email": "Mom@Gmail.com"}, home)
        self.assertEqual((code, view["emails"], view["members"][0]["anchor"]), (200, ["mom@gmail.com"], True))

        mom = self.google("S-MOM", "mom@gmail.com")
        self.assertEqual((mom["outcome"], mom["family"]["home"], mom["username"]), ("joined", True, "mom@gmail.com"))
        self.assertEqual(self.records(mom["token"]), ["home-1"])
        view = self.request("/api/family", token=mom["token"])[1]
        self.assertEqual(([m["email"] for m in view["members"]][1:], view["emails"]), (["mom@gmail.com"], []))
        self.assertTrue(view["members"][1]["you"])

        # Another family invites by link; the link works for anyone until it expires or is replaced.
        friend = self.google("S-F", "friend@gmail.com")["token"]
        self.save(friend, "friend-1", "60ml")
        invite = self.request("/api/family", "POST", {"action": "invite"}, friend)[1]
        self.assertIsNotNone(invite["invite"])
        partner = self.google("S-P", "partner@gmail.com", invite["code"])
        self.assertEqual((partner["outcome"], self.records(partner["token"])), ("joined", ["friend-1"]))

        # Someone who already started an empty family of their own moves in; that folder is set aside, not deleted.
        lone = self.google("S-L", "lone@gmail.com")
        lone_id = lone["token"][2:18]
        moved = self.google("S-L", "lone@gmail.com", invite["code"])
        self.assertEqual((moved["outcome"], self.records(moved["token"])), ("moved", ["friend-1"]))
        self.assertEqual(self.request("/api/data", token=lone["token"])[0], 401)
        self.assertFalse((self.directory / "families" / lone_id).exists())
        self.assertEqual(len(list((self.directory / "families" / ".retired").iterdir())), 1)

        # A member of a family that has records cannot be pulled into another one by a link.
        home_invite = self.request("/api/family", "POST", {"action": "invite"}, home)[1]["code"]
        refused = self.google("S-P", "partner@gmail.com", home_invite)
        self.assertIn("이미 다른 가족", refused["error"])
        # The connected home account never joins another family.
        self.assertIn("기본 가족 계정", self.google("HOME", "somsom@gmail.com", invite["code"])["error"])
        # An address another family registered cannot be claimed.
        self.assertEqual(self.request("/api/family", "POST", {"action": "add_email", "email": "aunt@gmail.com"}, home)[0], 200)
        self.assertEqual(self.request("/api/family", "POST", {"action": "add_email", "email": "aunt@gmail.com"}, friend)[0], 409)

        # Stopping or expiring the link refuses it.
        self.request("/api/family", "POST", {"action": "stop_invite"}, friend)
        self.assertIn("찾지 못했어요", self.google("S-X", "x@gmail.com", invite["code"])["error"])
        fresh = self.request("/api/family", "POST", {"action": "invite"}, friend)[1]["code"]
        with self.store.connect() as db:
            db.execute("UPDATE family_invites SET expires=?", (time.time() - 1,))
        self.assertIn("만료", self.google("S-X", "x@gmail.com", fresh)["error"])

    def connect(self, token, sub, scope, refresh="r1"):
        """Run the phone's 'Google 연결' round trip for the signed-in family. Returns the redirect fragment."""
        tokens = {"access_token": "at", "scope": scope}
        if refresh:
            tokens["refresh_token"] = refresh
        code, body = self.request("/api/google/start", "POST", {"mode": "connect", "returnTo": BACK}, token)
        self.assertEqual(code, 200)
        with patch.object(google_web, "exchange", lambda *a: dict(tokens)), \
             patch.object(google_web, "identity", lambda t: {"sub": sub, "email": "x@gmail.com", "email_verified": True}):
            state = dict(x.split("=", 1) for x in body["url"].split("?", 1)[1].split("&"))["state"]
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
            connection.request("GET", f"/api/google/callback?state={state}&code=abc")
            response = connection.getresponse(); response.read(); connection.close()
        return unquote(response.getheader("Location").split("#", 1)[1])

    def test_another_family_connects_its_own_google_account(self):
        import server as server_module
        from google_records import GoogleRecords, read_config
        other = self.google("S2", "other@gmail.com")["token"]
        family = other[2:18]
        made = []

        def fake_provision(directory, api, config, calendar, recreate=False):
            made.append((Path(directory).name, calendar, api.token))
            created = {"tasks", "sheet"} - ({"tasks", "sheet"} if config.get("task_list") else set())
            config.update(task_list="web-list", spreadsheet="sheet-1", ready=True)
            if calendar and not config.get("calendar_outbox"):
                config.update(calendar_inbox="primary", calendar_outbox="cal-out")
                created.add("calendar")
            save_config(directory, config)
            return created

        full = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/tasks " \
               "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events.owned " \
               "https://www.googleapis.com/auth/calendar.app.created"
        start = self.request("/api/google/start", "POST", {"mode": "connect", "returnTo": BACK}, other)[1]["url"]
        self.assertIn("calendar.app.created", unquote(start))  # the first connection asks for Calendar too
        with patch.object(server_module, "provision", fake_provision), patch.object(GoogleRecords, "run", lambda self: None):
            # The home family's account, a missing refresh token or unticked Tasks/Drive are refused.
            self.assertIn("이미 다른 가족", self.connect(other, "HOME", full))
            self.assertIn("google-error", self.connect(other, "S2", full, refresh=None))
            self.assertIn("Tasks와 Drive", self.connect(other, "S2", "openid https://www.googleapis.com/auth/tasks"))
            self.assertEqual(made, [])
            self.assertEqual(self.connect(other, "S2", full), "google-connected=new")
        self.assertEqual(made, [(family, True, "at")])
        saved = read_config(self.directory / "families" / family)
        self.assertEqual((saved["subject"], saved["refresh_token"], saved["calendar_write"]), ("S2", "r1", True))
        self.assertIsNone(read_config(self.directory / "families" / "nope"))
        view = self.request("/api/family", token=other)[1]
        self.assertEqual((view["google"]["connected"], view["google"]["calendar"]), (True, True))
        data = self.request("/api/data", token=other)[1]
        self.assertIn("google_status", data)
        self.assertEqual(data["google_status"]["auth_state"], "ready")
        # The home family is untouched: its own (here: incomplete) connection, not this family's bridge.
        home = self.request("/api/data", token=self.google("HOME", "s@gmail.com")["token"])[1]
        self.assertEqual((home["google_status"]["auth_state"], "sources" in home), ("configuration_error", False))

        # Records saved before connecting were queued for the new sheet; one saved now is too, for this family only.
        self.save(other, "o-1", "70ml")
        with self.server.family_store(family).connect() as db:
            self.assertTrue(db.execute("SELECT COUNT(*) FROM google_record_events").fetchone()[0] >= 1)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM google_record_events").fetchone()[0], 0)

        # The same Google account cannot be connected to a second family; reconnecting this one renews it.
        third = self.google("S3", "third@gmail.com")["token"]
        with patch.object(server_module, "provision", fake_provision), patch.object(GoogleRecords, "run", lambda self: None):
            self.assertIn("이미 다른 가족", self.connect(third, "S2", full))
            self.assertEqual(self.connect(other, "S2", full, refresh="r2"), "google-connected=1")
            self.assertIn("이 가족에 연결된", self.connect(other, "S9", full))
            # Leaving Calendar out on a reconnect would break the feeding calendar this family uses.
            self.assertIn("캘린더 권한까지", self.connect(other, "S2", full.rsplit(" ", 2)[0]))
        self.assertEqual(read_config(self.directory / "families" / family)["refresh_token"], "r2")
        # A family with a Google connection is never set aside, even without records: its last member stays.
        self.request("/api/items/records/o-1", "DELETE", token=other)
        self.assertEqual(self.request("/api/family", "POST", {"action": "remove_member", "email": "other@gmail.com"}, other)[0], 409)
        self.assertTrue((self.directory / "families" / family).exists())

    def test_reconnect_adds_the_calendar_and_remakes_deleted_resources(self):
        import server as server_module
        from google_records import GoogleRecords, read_config
        token = self.google("S2", "other@gmail.com")["token"]
        family = token[2:18]
        self.save(token, "early", "60ml")  # saved before connecting
        created = []

        def fake_provision(directory, api, config, calendar, recreate=False):
            made = set(created.pop(0)) if created else set()
            config.update(ready=True)
            for name in made | ({"tasks", "sheet"} if not config.get("task_list") else set()):
                key = {"tasks": "task_list", "sheet": "spreadsheet", "calendar": "calendar_outbox"}[name]
                config[key] = name + "-" + str(len(config))
            if calendar:
                config.setdefault("calendar_inbox", "primary")
                if not config.get("calendar_outbox"):
                    config["calendar_outbox"] = "cal-1"; made.add("calendar")
            save_config(directory, config)
            return made

        tasks_only = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/tasks " \
                     "https://www.googleapis.com/auth/drive.file"
        full = tasks_only + " https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.app.created"
        store = self.server.family_store(family)
        def count(sql):
            with store.connect() as db:
                return db.execute(sql).fetchone()[0]
        with patch.object(server_module, "provision", fake_provision), patch.object(GoogleRecords, "run", lambda self: None):
            # First connect without Calendar: sheet and Tasks only; the earlier record is sent too.
            self.assertEqual(self.connect(token, "S2", tasks_only), "google-connected=new-no-calendar")
            bridge = self.server.family_bridges[family]
            self.assertIsNone(bridge.calendar)
            self.assertEqual(count("SELECT COUNT(*) FROM google_record_events WHERE item_id='early'"), 1)
            # The reconnect asks for Calendar again; granting it adds the feeding calendar with past feedings.
            url = self.request("/api/google/start", "POST", {"mode": "connect", "returnTo": BACK}, token)[1]["url"]
            self.assertIn("calendar.app.created", unquote(url))
            self.assertEqual(self.connect(token, "S2", full, refresh="r2"), "google-connected=calendar")
            self.assertIs(self.server.family_bridges[family], bridge)
            self.assertEqual((bridge.calendar is not None, bridge.calendar.outbox), (True, "cal-1"))
            self.assertEqual(count("SELECT COUNT(*) FROM google_calendar_jobs WHERE item_id='early'"), 1)
            self.assertEqual(read_config(store.directory)["refresh_token"], "r2")

            # Pretend everything was delivered, then the family deletes the sheet and the Tasks list.
            with store.connect() as db:
                db.execute("UPDATE google_record_events SET sheet_done=1, task_done=1")
                db.execute("INSERT INTO google_task_links VALUES (?,?,?,?)", (bridge.binding, "records", "gone", "t-old"))
                db.execute("INSERT OR REPLACE INTO google_task_links VALUES (?,?,?,?)", (bridge.binding, "records", "early", "t-1"))
                db.execute("INSERT INTO google_delivery_retries VALUES (?,?,?,?,?,?,?)", (bridge.binding, "sheets", "1", 5, "Sheets 404", 9e9, 1))
            self.request("/api/items/records/early", "PUT", {"id": "early", "type": "feeding", "date": "2026-11-20T09:00",
                                                              "category": "분유", "amount": "65ml"}, token)
            self.save(token, "removed", "10ml")
            self.request("/api/items/records/removed", "DELETE", token=token)
            with store.connect() as db:
                db.execute("UPDATE google_record_events SET sheet_done=1, task_done=1")
            created.append({"sheet", "tasks"})
            self.assertEqual(self.connect(token, "S2", full, refresh="r3"), "google-connected=sheet,tasks")
            # Every sheet row goes again (same rows); Tasks get the latest copy of records that still exist only.
            self.assertEqual(count("SELECT COUNT(*) FROM google_record_events WHERE sheet_done=1"), 0)
            self.assertEqual(count("SELECT COUNT(*) FROM google_record_events WHERE task_done=0"), 1)
            self.assertEqual(count("SELECT item_id FROM google_record_events WHERE task_done=0"), "early")
            self.assertEqual(count("SELECT COUNT(*) FROM google_task_links"), 0)
            self.assertEqual(count("SELECT COUNT(*) FROM google_delivery_retries"), 0)
            self.assertNotEqual(bridge.config["spreadsheet"], "sheet-3")

            # A deleted feeding calendar is remade and every feeding is projected again.
            with store.connect() as db:
                db.execute("INSERT INTO google_calendar_links VALUES (?,?,?)", (bridge.binding, "early", "ev-old"))
                db.execute("DELETE FROM google_calendar_jobs")
            created.append({"calendar"})
            self.assertEqual(self.connect(token, "S2", full, refresh="r4"), "google-connected=calendar")
            self.assertEqual(count("SELECT COUNT(*) FROM google_calendar_links"), 0)
            self.assertEqual(count("SELECT COUNT(*) FROM google_calendar_jobs WHERE item_id='early'"), 1)

    def test_removing_a_member_signs_them_out(self):
        home = self.google("HOME", "somsom@gmail.com")["token"]
        self.request("/api/family", "POST", {"action": "add_email", "email": "mom@gmail.com"}, home)
        mom = self.google("S-MOM", "mom@gmail.com")["token"]
        result = self.request("/api/family", "POST", {"action": "remove_member", "email": "mom@gmail.com"}, home)[1]
        self.assertEqual((result["signed_out"], [m["email"] for m in result["members"]][1:]), (False, []))
        self.assertEqual(self.request("/api/data", token=mom)[0], 401)
        # Next time that account is in no family, so it starts its own.
        self.assertEqual(self.google("S-MOM", "mom@gmail.com")["outcome"], "created")

        # The last member of a family with records cannot leave; an empty family is set aside when they do.
        solo = self.google("S-S", "solo@gmail.com")["token"]
        self.save(solo, "solo-1", "50ml")
        self.assertEqual(self.request("/api/family", "POST", {"action": "remove_member", "email": "solo@gmail.com"}, solo)[0], 409)
        self.request("/api/items/records/solo-1", "DELETE", token=solo)
        left = self.request("/api/family", "POST", {"action": "remove_member", "email": "solo@gmail.com"}, solo)[1]
        self.assertTrue(left["signed_out"])
        self.assertEqual(self.request("/api/data", token=solo)[0], 401)

        # The guest manages nothing.
        self.store.password("guest", "guest-password-1")
        guest = self.request("/api/login", "POST", {"username": "guest", "password": "guest-password-1"})[1]["token"]
        self.assertEqual(self.request("/api/family", token=guest)[0], 403)


if __name__ == "__main__":
    unittest.main()
