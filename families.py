"""Families: which records a signed-in Google account sees.

The original family keeps its data where it always was (the data folder itself, family id ``home``).
Each other family gets its own folder under ``families/<id>/`` with its own SQLite file and backups,
so one family can never read another's records. The registry below lives in the home database:

- a Google account (its stable ``sub``) belongs to at most one family;
- a family can pre-register a member's e-mail address, or hand out a 7-day invite link;
- an account that is in no family and was not invited starts a new, empty family of its own.

Python standard library only.
"""
import hashlib
import re
import secrets
import time
from datetime import datetime

HOME = "home"
TOKEN_PREFIX = "f-"
ID_PATTERN = re.compile(r"[0-9a-f]{16}")
EMAIL_PATTERN = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")
INVITE_SECONDS = 7 * 86400
MAX_FAMILIES = 20
MAX_EMAILS = 20
HOME_NAME = "우리 가족"

SCHEMA = """
CREATE TABLE IF NOT EXISTS families(id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS family_members(sub TEXT PRIMARY KEY, email TEXT NOT NULL, family TEXT NOT NULL, joined TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS family_emails(email TEXT PRIMARY KEY, family TEXT NOT NULL, added TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS family_invites(family TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires REAL NOT NULL);
"""


class Refused(Exception):
    """A sign-in or family change that is not allowed; the message is shown to the person."""

    def __init__(self, message, status=409):
        super().__init__(message)
        self.message, self.status = message, status


def now_text():
    return datetime.now().isoformat(timespec="seconds")


def normalize_email(value):
    email = value.strip().lower() if isinstance(value, str) else ""
    if len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
        raise Refused("Google 계정 이메일 주소를 확인해 주세요.", 400)
    return email


def family_of_token(token):
    """The family id a session token belongs to: HOME for the original tokens, else the id in its prefix."""
    if not token.startswith(TOKEN_PREFIX):
        return HOME
    family = token[len(TOKEN_PREFIX):].split(".", 1)[0]
    return family if ID_PATTERN.fullmatch(family) else None


def session_prefix(family):
    return "" if family == HOME else f"{TOKEN_PREFIX}{family}."


def code_hash(code):
    return hashlib.sha256(code.encode()).hexdigest()


class Registry:
    """Membership, pre-registered addresses and invites. Every method takes a home-database connection."""

    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript(SCHEMA)

    @staticmethod
    def exists(db, family):
        return family == HOME or db.execute("SELECT 1 FROM families WHERE id=?", (family,)).fetchone() is not None

    @staticmethod
    def name(db, family):
        if family == HOME:
            return HOME_NAME
        row = db.execute("SELECT name FROM families WHERE id=?", (family,)).fetchone()
        return row[0] if row else ""

    @staticmethod
    def families(db):
        return [(HOME, HOME_NAME)] + db.execute("SELECT id,name FROM families ORDER BY created").fetchall()

    @staticmethod
    def membership(db, sub):
        row = db.execute("SELECT family,email FROM family_members WHERE sub=?", (sub,)).fetchone()
        return (row[0], row[1]) if row else (None, None)

    def invited_family(self, db, code):
        if not isinstance(code, str) or not 0 < len(code) <= 100:
            return None
        row = db.execute("SELECT family,expires FROM family_invites WHERE code_hash=?", (code_hash(code),)).fetchone()
        if row is None:
            raise Refused("초대 링크를 찾지 못했어요. 새 초대 링크를 받아 주세요.")
        if row[1] <= time.time():
            raise Refused("초대 링크가 만료됐어요. 가족에게 새 초대 링크를 받아 주세요.")
        return row[0]

    def sign_in(self, db, sub, email, invite, home_subject, is_empty):
        """Decide the family for a verified Google account. Returns (family, username, outcome).

        Order: the account the home Google bridge is connected to always opens the home family; then an
        invite link, then an address a family pre-registered; then an existing membership; else a new family.
        ``is_empty(family)`` tells whether a family has no records, so a lone member can move out of it.
        """
        if home_subject and sub == home_subject:
            if invite:
                raise Refused("이 계정은 솜하우스에 연결된 기본 가족 계정이라 다른 가족에 들어갈 수 없어요.")
            return HOME, "family", "home"
        email = normalize_email(email)
        target = self.invited_family(db, invite) if invite else None
        registered = db.execute("SELECT family FROM family_emails WHERE email=?", (email,)).fetchone()
        target = target or (registered[0] if registered else None)
        current, _ = self.membership(db, sub)
        if target is not None and not self.exists(db, target):
            target = None
        if target is not None and target != current:
            if current is not None:
                alone = db.execute("SELECT COUNT(*) FROM family_members WHERE family=?", (current,)).fetchone()[0] == 1
                if current == HOME or not alone or not is_empty(current):
                    raise Refused(f"이미 다른 가족({self.name(db, current)})에 속해 있어요. 그 가족의 ‘가족 관리’에서 "
                                  "나가기를 한 뒤 다시 시도해 주세요.")
                self.drop_family(db, current)
                outcome = "moved"
            else:
                outcome = "joined"
            db.execute("INSERT INTO family_members VALUES(?,?,?,?) ON CONFLICT(sub) DO UPDATE SET "
                       "email=excluded.email,family=excluded.family,joined=excluded.joined", (sub, email, target, now_text()))
            db.execute("DELETE FROM family_emails WHERE email=?", (email,))
            return target, email, outcome
        if current is not None:
            db.execute("UPDATE family_members SET email=? WHERE sub=?", (email, sub))
            db.execute("DELETE FROM family_emails WHERE email=? AND family=?", (email, current))
            return current, email, "member"
        if db.execute("SELECT COUNT(*) FROM families").fetchone()[0] >= MAX_FAMILIES:
            raise Refused("지금은 새 가족을 더 만들 수 없어요. 관리자에게 문의해 주세요.", 403)
        family = secrets.token_hex(8)
        db.execute("INSERT INTO families VALUES(?,?,?)", (family, f"{email.split('@')[0]}님의 가족", now_text()))
        db.execute("INSERT INTO family_members VALUES(?,?,?,?)", (sub, email, family, now_text()))
        return family, email, "created"

    @staticmethod
    def drop_family(db, family):
        for table, column in (("families", "id"), ("family_members", "family"), ("family_emails", "family"),
                              ("family_invites", "family")):
            db.execute(f"DELETE FROM {table} WHERE {column}=?", (family,))

    def overview(self, db, family, username, anchor_email=""):
        invite = db.execute("SELECT expires FROM family_invites WHERE family=? AND expires>?", (family, time.time())).fetchone()
        members = [{"email": email, "you": email == username, "anchor": False} for (email,) in db.execute(
            "SELECT email FROM family_members WHERE family=? ORDER BY joined", (family,))]
        if family == HOME:
            members.insert(0, {"email": anchor_email or "연결된 가족 Google 계정", "you": username == "family", "anchor": True})
        return {"name": self.name(db, family), "home": family == HOME, "members": members,
                "emails": [row[0] for row in db.execute("SELECT email FROM family_emails WHERE family=? ORDER BY added", (family,))],
                "invite": {"expires": datetime.fromtimestamp(invite[0]).isoformat(timespec="minutes")} if invite else None}

    def change(self, db, family, body, is_empty):
        """Apply one family-management action. Returns (result, removed member e-mail or None)."""
        action = body.get("action")
        if action == "add_email":
            email = normalize_email(body.get("email"))
            if db.execute("SELECT 1 FROM family_members WHERE email=? AND family=?", (email, family)).fetchone():
                raise Refused("이미 가족으로 들어와 있는 계정이에요.")
            row = db.execute("SELECT family FROM family_emails WHERE email=?", (email,)).fetchone()
            if row and row[0] != family:
                raise Refused("이 주소는 등록할 수 없어요. 초대 링크를 보내 주세요.")
            if db.execute("SELECT COUNT(*) FROM family_emails WHERE family=?", (family,)).fetchone()[0] >= MAX_EMAILS:
                raise Refused(f"미리 등록한 주소는 {MAX_EMAILS}개까지예요.")
            db.execute("INSERT OR IGNORE INTO family_emails VALUES(?,?,?)", (email, family, now_text()))
            return {}, None
        if action == "remove_email":
            db.execute("DELETE FROM family_emails WHERE email=? AND family=?", (normalize_email(body.get("email")), family))
            return {}, None
        if action == "remove_member":
            email = normalize_email(body.get("email"))
            row = db.execute("SELECT sub FROM family_members WHERE email=? AND family=?", (email, family)).fetchone()
            if row is None:
                raise Refused("이미 나갔거나 찾을 수 없는 가족이에요. 화면을 새로고침해 주세요.")
            left = db.execute("SELECT COUNT(*) FROM family_members WHERE family=?", (family,)).fetchone()[0]
            if family != HOME and left == 1 and not is_empty(family):
                raise Refused("기록이나 Google 연결이 있는 가족의 마지막 구성원은 나갈 수 없어요. 먼저 다른 가족을 초대해 주세요.")
            db.execute("DELETE FROM family_members WHERE sub=?", (row[0],))
            if family != HOME and left == 1:
                self.drop_family(db, family)
            return {}, email
        if action == "invite":
            code = secrets.token_urlsafe(16)
            expires = time.time() + INVITE_SECONDS
            db.execute("INSERT INTO family_invites VALUES(?,?,?) ON CONFLICT(family) DO UPDATE SET "
                       "code_hash=excluded.code_hash,expires=excluded.expires", (family, code_hash(code), expires))
            return {"code": code}, None
        if action == "stop_invite":
            db.execute("DELETE FROM family_invites WHERE family=?", (family,))
            return {}, None
        raise Refused("요청한 가족 관리 작업을 확인해 주세요.", 400)


__all__ = ["HOME", "HOME_NAME", "MAX_FAMILIES", "Refused", "Registry", "family_of_token", "normalize_email",
           "session_prefix"]
