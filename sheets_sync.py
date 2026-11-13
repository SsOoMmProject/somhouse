"""Copy the current SQLite feeding records to one dedicated Google Sheets tab."""

import hashlib
import json
import math
import re
import sys
import threading
from urllib.parse import urlencode

CONFIG_NAME = "sheets-config.json"
KEY_NAME = "sheets-service-account.json"
SCOPE = "https://www.googleapis.com/auth/spreadsheets"
CHECK_INTERVAL = 3600
COLUMNS = ("기록 ID", "날짜", "날짜와 시간", "수유 종류", "입력한 양 또는 시간", "용량 (ml)", "메모")
VOLUME = re.compile(r"\s*(\d+(?:\.\d+)?)\s*(?:ml|미리|밀리리터)\s*", re.IGNORECASE | re.ASCII)


def feeding_rows(records):
    rows = [list(COLUMNS)]
    feeding = sorted(
        (item for item in records if item["type"] == "feeding"),
        key=lambda item: (item["date"], item["id"]),
    )
    for item in feeding:
        amount = item["amount"]
        match = VOLUME.fullmatch(amount)
        volume = float(match[1]) if match else None
        if volume is not None and not math.isfinite(volume):
            volume = None
        rows.append([
            item["id"], item["date"][:10], item["date"], item["category"],
            amount, volume, item.get("memo", ""),
        ])
    return rows


def cell(value):
    if value is None:
        return {}
    if isinstance(value, str):
        return {"userEnteredValue": {"stringValue": value}}
    return {"userEnteredValue": {"numberValue": value}}


class SheetsSync:
    def __init__(self, store, spreadsheet_id, sheet_id, session):
        self.store = store
        self.url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}"
        self.sheet_id = sheet_id
        self.session = session
        self.last_digest = None
        self.wake = threading.Event()
        self.lock = threading.Lock()

    @classmethod
    def load(cls, store):
        config_path = store.directory / CONFIG_NAME
        if not config_path.exists():
            return None
        key_path = store.directory / KEY_NAME
        if key_path.stat().st_mode & 0o077:
            raise ValueError("Sheets credential file must be private")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        spreadsheet_id = config["spreadsheetId"]
        sheet_id = config["sheetId"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", spreadsheet_id) or type(sheet_id) is not int or sheet_id < 0:
            raise ValueError("Invalid Sheets spreadsheet ID or tab ID")

        # Only the optional Sheets integration requires these packages.
        from google.auth.transport.requests import AuthorizedSession
        from google.oauth2.service_account import Credentials

        credentials = Credentials.from_service_account_file(str(key_path), scopes=[SCOPE])
        return cls(store, spreadsheet_id, sheet_id, AuthorizedSession(credentials))

    def sync(self, force=False):
        with self.store.connect() as db:
            records = self.store.state(db)["records"]
        rows = feeding_rows(records)
        digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).digest()
        if not force and digest == self.last_digest:
            return False

        # A failed forced refresh must also be retried by the hourly check.
        self.last_digest = None
        query = urlencode({"fields": "sheets(properties(sheetId,gridProperties(rowCount,columnCount)))"})
        response = self.session.get(f"{self.url}?{query}", timeout=15)
        response.raise_for_status()
        sheet = next((item["properties"] for item in response.json()["sheets"]
                      if item["properties"]["sheetId"] == self.sheet_id), None)
        if sheet is None or "gridProperties" not in sheet:
            raise ValueError("Sheets tab is missing or has no grid")

        requests = []
        grid = sheet["gridProperties"]
        for dimension, required, available in (
            ("ROWS", len(rows), grid["rowCount"]),
            ("COLUMNS", len(COLUMNS), grid["columnCount"]),
        ):
            if required > available:
                requests.append({"appendDimension": {
                    "sheetId": self.sheet_id, "dimension": dimension, "length": required - available,
                }})
        requests.append({"updateCells": {
            "range": {
                "sheetId": self.sheet_id, "startRowIndex": 0,
                "endRowIndex": max(grid["rowCount"], len(rows)),
                "startColumnIndex": 0, "endColumnIndex": len(COLUMNS),
            },
            "rows": [{"values": [cell(value) for value in row]} for row in rows],
            "fields": "userEnteredValue",
        }})
        response = self.session.post(f"{self.url}:batchUpdate", json={"requests": requests}, timeout=30)
        response.raise_for_status()
        self.last_digest = digest
        return True

    def run(self, stop):
        while not stop.is_set():
            # Clear before reading SQLite so writes during an export wake the next pass.
            self.wake.clear()
            if stop.is_set():
                return
            try:
                with self.lock:
                    self.sync()
            except Exception as error:
                self.log_failure(error)
            self.wake.wait(CHECK_INTERVAL)

    @staticmethod
    def log_failure(error):
        # Response bodies and request details can contain private data.
        status = getattr(getattr(error, "response", None), "status_code", None)
        detail = f" (HTTP {status})" if type(status) is int else ""
        print(f"Google Sheets sync failed: {type(error).__name__}{detail}", file=sys.stderr, flush=True)
