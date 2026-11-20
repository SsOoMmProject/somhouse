"""Create (or reuse) what the records bridge writes to in a Google account: the web Tasks list, the source
sheet and, with Calendar, the app's feeding calendar. Shared by the Mac setup script and the phone's
connection. IDs are saved as each resource is made, so a retry after a failure reuses them.
Python standard library only.
"""
from calendar_records import CALENDAR, CALENDAR_NAME, event_pages
from google_records import HEADERS, SHEETS, TAB, TASKS, GoogleError, save_config

GONE = (404, 410)
DRIVE_FILES = "https://www.googleapis.com/drive/v3/files/"


def provision(directory, api, config, calendar, *, recreate=False):
    """Make ``config`` ready for GoogleRecords and return the set of resources created by this call.

    With ``recreate``, a Tasks list, sheet or feeding calendar that the family deleted (or a sheet moved to
    the Drive trash) is made again; the caller then resends what lived there. Without it a missing resource
    is an error, as before. Raises GoogleError when Google refuses a step.
    """
    made = set()

    def missing(check):
        try:
            check()
            return False
        except GoogleError as error:
            if recreate and error.status in GONE:
                return True
            raise

    def sheet_check():
        meta = api.request(DRIVE_FILES + config["spreadsheet"] + "?fields=trashed", service="Drive")
        if meta.get("trashed") is True:
            raise GoogleError(404, "Sheets")
        api.sheet_cell("A1")

    if config["inbox"] == config.get("task_list"):
        raise ValueError("음성 입력 목록과 웹 기록 목록은 서로 달라야 합니다.")
    next(iter(api.tasks(config["inbox"])), None)
    if not config.get("ready"):
        save_config(directory, config)
    if config.get("task_list") and missing(lambda: next(iter(api.tasks(config["task_list"])), None)):
        del config["task_list"]
    if not config.get("task_list"):
        task_list = api.request(TASKS + "users/@me/lists", "POST", {"title": "솜하우스 웹 기록"}, "Tasks")
        config["task_list"] = task_list["id"]
        made.add("tasks")
        save_config(directory, config)
    if config.get("spreadsheet") and recreate and missing(sheet_check):
        del config["spreadsheet"]
        config.pop("source_sheet_id", None)
        api.sheet_id, api.sheet_size = None, None
    if not config.get("spreadsheet"):
        spreadsheet = api.request(SHEETS, "POST", {
            "properties": {"title": "솜하우스 원본 기록", "locale": "ko_KR", "timeZone": "Asia/Seoul"},
            "sheets": [{"properties": {"title": TAB, "gridProperties": {
                "frozenRowCount": 1, "rowCount": 1000, "columnCount": 20}}}],
        }, "Sheets")
        config["spreadsheet"] = spreadsheet["spreadsheetId"]
        made.add("sheet")
        save_config(directory, config)
    if api.sheet_cell("A1") != [[HEADERS[0]]]:
        api.sheet_row(1, HEADERS)
    if api.sheet_cell("A1") != [[HEADERS[0]]]:
        raise GoogleError("원본 시트 헤더 확인 실패", "Sheets")
    api.protect_source()
    config["source_sheet_id"] = api.sheet_id
    if calendar:
        config.setdefault("calendar_inbox", "primary")
        next(event_pages(api, config["calendar_inbox"], maxResults=1), None)
        if config.get("calendar_outbox") and missing(
                lambda: next(event_pages(api, config["calendar_outbox"], maxResults=1), None)):
            del config["calendar_outbox"]
        if not config.get("calendar_outbox"):
            target = api.request(CALENDAR, "POST", {"summary": CALENDAR_NAME, "timeZone": "Asia/Seoul"}, "Calendar")
            config["calendar_outbox"] = target["id"]
            made.add("calendar")
            save_config(directory, config)
        next(event_pages(api, config["calendar_outbox"], maxResults=1), None)
    config["ready"] = True
    save_config(directory, config)
    return made


__all__ = ["provision"]
