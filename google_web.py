"""Google sign-in and in-app reconnection through a "Web application" OAuth client.

The family shares one Google account. Signing in proves the person holds that account (the same Google
subject the records bridge is connected to). Reconnecting renews the bridge's refresh token from a phone,
without the Mac terminal. Python standard library only.
"""
import base64
import hashlib
import json
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from google_records import GoogleAPI, TASKS, json_request

WEB_CONFIG_NAME = "google-web-client.json"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
LOGIN_SCOPES = ("openid", "https://www.googleapis.com/auth/userinfo.email")
CALLBACK_PATH = "/api/google/callback"
FAMILY_USER = "family"


def load_web_client(directory):
    """The web client settings, or None when the administrator has not set them up."""
    path = Path(directory) / WEB_CONFIG_NAME
    try:
        if path.stat().st_mode & 0o077:
            return None
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    keys = ("client_id", "client_secret", "redirect_uri")
    if isinstance(config, dict) and all(isinstance(config.get(k), str) and config[k] for k in keys):
        return config
    return None


def save_web_client(directory, client_file, public_url):
    """Validate a downloaded 'Web application' client JSON and store what the server needs (mode 0600)."""
    client = json.loads(Path(client_file).read_text(encoding="utf-8"))
    web = client.get("web") if isinstance(client, dict) else None
    if not isinstance(web, dict) or not web.get("client_id") or not web.get("client_secret"):
        raise ValueError("Google Cloud에서 다운로드한 '웹 애플리케이션' OAuth JSON을 지정해 주세요.")
    parts = urlsplit(public_url)
    if parts.scheme != "https" or not parts.netloc or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("--public-url에는 서버의 공개 HTTPS 주소만 적어 주세요. 예: https://이름.ts.net")
    redirect = f"https://{parts.netloc}{CALLBACK_PATH}"
    if redirect not in (web.get("redirect_uris") or []):
        raise ValueError(f"Google Cloud의 승인된 리디렉션 URI에 {redirect} 를 추가하고 JSON을 다시 받아 주세요.")
    path = Path(directory) / WEB_CONFIG_NAME
    path.write_text(json.dumps({"client_id": web["client_id"], "client_secret": web["client_secret"],
                                "redirect_uri": redirect}), encoding="utf-8")
    path.chmod(0o600)
    return redirect


class Pending:
    """Short-lived, single-use values kept in memory: OAuth states and one-time login codes."""

    def __init__(self, lifetime, limit=50):
        self.lifetime, self.limit, self.items, self.lock = lifetime, limit, {}, threading.Lock()

    def add(self, value):
        key = secrets.token_urlsafe(32)
        with self.lock:
            now = time.monotonic()
            self.items = {k: v for k, v in self.items.items() if v[0] > now}
            if len(self.items) >= self.limit:
                self.items.pop(min(self.items, key=lambda k: self.items[k][0]))
            self.items[key] = (now + self.lifetime, value)
        return key

    def take(self, key):
        with self.lock:
            entry = self.items.pop(key, None) if isinstance(key, str) else None
        return entry[1] if entry and entry[0] > time.monotonic() else None


def authorization_url(client, state, verifier, scopes, *, offline):
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    params = {"client_id": client["client_id"], "redirect_uri": client["redirect_uri"], "response_type": "code",
              "scope": " ".join(scopes), "state": state, "code_challenge": challenge,
              "code_challenge_method": "S256"}
    if offline:
        params.update(access_type="offline", prompt="consent select_account")
    else:
        params["prompt"] = "select_account"
    return AUTH_URL + "?" + urlencode(params)


def exchange(client, code, verifier):
    """Trade the callback code for tokens (direct HTTPS call to Google, so the reply itself is trusted)."""
    fields = {"code": code, "client_id": client["client_id"], "client_secret": client["client_secret"],
              "redirect_uri": client["redirect_uri"], "grant_type": "authorization_code", "code_verifier": verifier}
    return json_request(TOKEN_URL, "POST", urlencode(fields).encode(),
                        {"Content-Type": "application/x-www-form-urlencoded"}, "OAuth")


def identity(access_token):
    return json_request(USERINFO_URL, "GET", None, {"Authorization": f"Bearer {access_token}"}, "Google 계정")


def check_access(config, access_token, calendar):
    """Before adopting new credentials, read what the bridge already uses: Tasks lists, the sheet, the calendar."""
    api = GoogleAPI(config, access_token)
    next(iter(api.tasks(config["inbox"])), None)
    next(iter(api.tasks(config["task_list"])), None)
    api.request(f"https://sheets.googleapis.com/v4/spreadsheets/{config['spreadsheet']}?fields=spreadsheetId",
                service="Sheets")
    if calendar:
        from urllib.parse import quote
        for key in ("calendar_inbox", "calendar_outbox"):  # voice intake reads the inbox, feedings go to the outbox
            api.request("https://www.googleapis.com/calendar/v3/calendars/" + quote(config[key], safe="")
                        + "/events?maxResults=1", service="Calendar")
    return True


__all__ = ["CALLBACK_PATH", "FAMILY_USER", "LOGIN_SCOPES", "Pending", "TASKS", "WEB_CONFIG_NAME",
           "authorization_url", "check_access", "exchange", "identity", "load_web_client", "save_web_client"]
