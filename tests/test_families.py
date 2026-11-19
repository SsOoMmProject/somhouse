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
        self.assertEqual(self.request("/api/google/start", "POST", {"mode": "connect", "returnTo": BACK}, other["token"])[0], 409)
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
