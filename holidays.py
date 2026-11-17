"""Korean public holidays (including substitute holidays) for the family calendar.

The list comes from Google's public "대한민국의 휴일" calendar feed, which needs no account. Only days
Google marks as 공휴일 are kept; observances such as 어버이날 (기념일) are dropped. Nothing about the
family is sent: it is a plain download of a public file. When a download fails the last saved list
stays in use.
"""
import re
import sys
import threading
from datetime import date, timedelta
from urllib.request import Request, urlopen

FEED = ("https://calendar.google.com/calendar/ical/"
        "ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics")
SCHEMA = """
CREATE TABLE IF NOT EXISTS holidays (day TEXT PRIMARY KEY, name TEXT NOT NULL, substitute INTEGER NOT NULL);
"""
REFRESH_SECONDS = 24 * 3600
SUBSTITUTE = "쉬는 날 "


def parse_ics(text):
    """Return [(YYYY-MM-DD, name, substitute)] for public holidays in an iCalendar feed."""
    text = re.sub(r"\r?\n[ \t]", "", text)  # unfold continuation lines
    found = {}
    for block in text.split("BEGIN:VEVENT")[1:]:
        start = re.search(r"\nDTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})", block)
        summary = re.search(r"\nSUMMARY:([^\r\n]*)", block)
        description = re.search(r"\nDESCRIPTION:([^\r\n]*)", block)
        if not start or not summary or not description or not description[1].startswith("공휴일"):
            continue
        try:
            day = date(int(start[1]), int(start[2]), int(start[3])).isoformat()
        except ValueError:
            continue
        name = summary[1].strip().replace("\\,", ",")[:40]
        substitute = name.startswith(SUBSTITUTE)
        if substitute:
            name = name.removeprefix(SUBSTITUTE).strip()
        if name:
            found[day] = (day, name, int(substitute))
    return sorted(found.values())


def save(db, rows):
    """Replace the stored list; an empty or broken download never wipes what is there."""
    if not rows:
        return False
    db.execute("DELETE FROM holidays")
    db.executemany("INSERT OR REPLACE INTO holidays VALUES (?,?,?)", rows)
    return True


def listing(db, today=None):
    """Holidays from last year to two years ahead, for the web."""
    today = today or date.today()
    start, end = (today - timedelta(days=366)).isoformat(), (today + timedelta(days=731)).isoformat()
    return [{"date": day, "name": name, "substitute": bool(substitute)} for day, name, substitute in db.execute(
        "SELECT day,name,substitute FROM holidays WHERE day BETWEEN ? AND ? ORDER BY day", (start, end))]


def download():
    request = Request(FEED, headers={"User-Agent": "somhouse-holidays"})
    with urlopen(request, timeout=20) as response:
        return response.read(2_000_000).decode("utf-8", "replace")


class HolidayFeed:
    def __init__(self, store):
        self.store, self.stop = store, threading.Event()

    def refresh(self):
        rows = parse_ics(download())
        with self.store.lock, self.store.connect() as db:
            return save(db, rows)

    def run(self):
        while not self.stop.is_set():
            try:
                self.refresh()
                wait = REFRESH_SECONDS
            except (OSError, ValueError) as error:
                print(f"공휴일 목록 받기 실패 · {type(error).__name__}", file=sys.stderr, flush=True)
                wait = 3600
            self.stop.wait(wait)
