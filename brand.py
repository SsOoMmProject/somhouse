"""The app's display name, chosen per deployment (default 솜하우스).

Set SOMHOUSE_BRAND for the server (e.g. in the LaunchAgent) and window.SOMHOUSE_BRAND in config.js for the web.
Only names people see change: Google resources created from now on, messages, the voice-command prefix.
Internal markers already stored in Google ("[솜하우스 …]" tags, the sheet protection note) stay fixed so existing
data keeps matching, and voice commands keep accepting "솜하우스" as well as the new name.
"""
import os
import re

DEFAULT = "솜하우스"


def load(value=None):
    name = " ".join(str(os.environ.get("SOMHOUSE_BRAND", "") if value is None else value).split())
    return name if 0 < len(name) <= 20 and re.fullmatch(r"[0-9A-Za-z가-힣 ]+", name) else DEFAULT


NAME = load()


def prefix_pattern(*names):
    """A voice title prefix such as '솜하우스', '솜 하우스' or '솜하우스:' for every given name."""
    spaced = sorted({r"\s*".join(map(re.escape, name.replace(" ", ""))) for name in names}, key=len, reverse=True)
    return re.compile(r"^(?:" + "|".join(spaced) + r")(?=$|[\s:：,])\s*[:：,]?\s*")
