"""A feeding means the baby is awake: it ends the sleep that is still open at that time."""
from datetime import datetime, timedelta
import json

# A sleep left open for longer than this is a forgotten record, not one a feeding should close.
OPEN_SLEEP_LIMIT = timedelta(hours=16)


def open_sleep(records, at):
    """The latest sleep without a wake time that started at or before `at` ("YYYY-MM-DDTHH:MM"), within the limit.

    A sleep started in the same minute counts too: tapping 수면 시작 and then a feeding is a baby who woke up.
    """
    try:
        moment = datetime.fromisoformat(at[:16])
    except (TypeError, ValueError):
        return None
    found = None
    for item in records:
        if item.get("type") != "sleep" or item.get("end") or not item.get("date"):
            continue
        try:
            start = datetime.fromisoformat(item["date"][:16])
        except ValueError:
            continue
        if start <= moment and moment - start <= OPEN_SLEEP_LIMIT and (found is None or item["date"] > found["date"]):
            found = item
    return found


def end_open_sleep(db, at):
    """Write `at` as the wake time of the open sleep (at least one minute after it began). Returns it, or None.

    The caller has already taken a snapshot in the same transaction and queues the sleep for Google.
    """
    records = [json.loads(row[0]) for row in db.execute("SELECT body FROM items WHERE kind='records'")]
    sleep = open_sleep(records, at)
    if sleep is None:
        return None
    end = at[:16]
    if end <= sleep["date"][:16]:
        end = (datetime.fromisoformat(sleep["date"][:16]) + timedelta(minutes=1)).isoformat(timespec="minutes")
    sleep = {**sleep, "end": end}
    db.execute("UPDATE items SET body=? WHERE kind='records' AND id=?",
               (json.dumps(sleep, ensure_ascii=False, sort_keys=True, separators=(",", ":")), sleep["id"]))
    return sleep


def end_sleep_on_feeding(db, feeding):
    """A feeding ends the sleep that is still open at its time. Returns the changed sleep, or None."""
    if not isinstance(feeding, dict) or feeding.get("type") != "feeding" or not isinstance(feeding.get("date"), str):
        return None
    return end_open_sleep(db, feeding["date"])
