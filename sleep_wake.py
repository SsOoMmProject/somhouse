"""A feeding means the baby is awake: it ends the sleep that is still open at that time."""
from datetime import datetime, timedelta
import json

# A sleep left open for longer than this is a forgotten record, not one a feeding should close.
OPEN_SLEEP_LIMIT = timedelta(hours=16)


def open_sleep(records, at):
    """The latest sleep without a wake time that started before `at` ("YYYY-MM-DDTHH:MM") and within the limit."""
    try:
        moment = datetime.fromisoformat(at)
    except (TypeError, ValueError):
        return None
    found = None
    for item in records:
        if item.get("type") != "sleep" or item.get("end") or not item.get("date"):
            continue
        try:
            start = datetime.fromisoformat(item["date"])
        except ValueError:
            continue
        if start < moment and moment - start <= OPEN_SLEEP_LIMIT and (found is None or item["date"] > found["date"]):
            found = item
    return found


def end_sleep_on_feeding(db, feeding):
    """Write the feeding's time as the wake time of the open sleep. Returns the changed sleep, or None.

    The caller has already taken a snapshot in the same transaction and queues the sleep for Google.
    """
    if not isinstance(feeding, dict) or feeding.get("type") != "feeding":
        return None
    records = [json.loads(row[0]) for row in db.execute("SELECT body FROM items WHERE kind='records'")]
    sleep = open_sleep(records, feeding.get("date"))
    if sleep is None:
        return None
    sleep = {**sleep, "end": feeding["date"][:16]}
    db.execute("UPDATE items SET body=? WHERE kind='records' AND id=?",
               (json.dumps(sleep, ensure_ascii=False, sort_keys=True, separators=(",", ":")), sleep["id"]))
    return sleep
