"""Create (or reuse) what the records bridge writes to in a Google account: the web Tasks list, the source
sheet and, with Calendar, the app's feeding calendar. Shared by the Mac setup script and the phone's first
connection. IDs are saved as each resource is made, so a retry after a failure reuses them.
Python standard library only.
"""
from calendar_records import CALENDAR, CALENDAR_NAME, event_pages
from google_records import HEADERS, SHEETS, TAB, TASKS, GoogleError, save_config


def provision(directory, api, config, calendar):
    """Make ``config`` ready for GoogleRecords; returns it. Raises GoogleError when Google refuses a step."""
    if config["inbox"] == config.get("task_list"):
        raise ValueError("음성 입력 목록과 웹 기록 목록은 서로 달라야 합니다.")
    next(iter(api.tasks(config["inbox"])), None)
    if not config.get("ready"):
        save_config(directory, config)
    if not config.get("task_list"):
        task_list = api.request(TASKS + "users/@me/lists", "POST", {"title": "솜하우스 웹 기록"}, "Tasks")
        config["task_list"] = task_list["id"]
        save_config(directory, config)
    else:
        next(iter(api.tasks(config["task_list"])), None)
    if not config.get("spreadsheet"):
        spreadsheet = api.request(SHEETS, "POST", {
            "properties": {"title": "솜하우스 원본 기록", "locale": "ko_KR", "timeZone": "Asia/Seoul"},
            "sheets": [{"properties": {"title": TAB, "gridProperties": {
                "frozenRowCount": 1, "rowCount": 1000, "columnCount": 20}}}],
        }, "Sheets")
        config["spreadsheet"] = spreadsheet["spreadsheetId"]
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
        if not config.get("calendar_outbox"):
            target = api.request(CALENDAR, "POST", {"summary": CALENDAR_NAME, "timeZone": "Asia/Seoul"}, "Calendar")
            config["calendar_outbox"] = target["id"]
            save_config(directory, config)
        next(event_pages(api, config["calendar_outbox"], maxResults=1), None)
    config["ready"] = True
    save_config(directory, config)
    return config


__all__ = ["provision"]
