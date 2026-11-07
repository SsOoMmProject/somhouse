"""Gemini transport and the limited record summaries shared with it."""
from collections import defaultdict, deque
from datetime import timedelta
import http.client
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import threading
import time

CONFIG_NAME = "gemini-config.json"
MODEL = "gemini-3.5-flash-lite"
# Keep the response deadline below the browser's 25-second limit so a slow
# reply frees the per-account slot before the family member can retry.
DEADLINE_SECONDS = 18
SCOPES = {"none": None, "feeding": "records", "schedule": "schedule", "shopping": "shopping"}
VOLUME = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:ml|미리|밀리리터)", re.IGNORECASE)
SYSTEM = (
    "솜하우스의 가족 기록 도우미로 한국어로 간결하게 답하세요. "
    "제공된 집계의 날짜, 건수, 수유량만 근거로 삼고 누락된 기록이나 세부 내용을 지어내지 마세요. "
    "수유량 합계는 ml가 명시된 기록만 포함합니다. 가족 기록 질문에 필요한 집계가 없으면 이를 알리세요. "
    "기록을 생성하거나 변경했다고 말하지 마세요. 의료 진단이나 처방을 제공하지 마세요."
)


class GeminiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def valid_key(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,256}", value) is not None


def save_config(directory, key, allow_summaries):
    descriptor, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump({"apiKey": key, "allowRecordSummaries": allow_summaries}, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, directory / CONFIG_NAME)
    finally:
        Path(temporary).unlink(missing_ok=True)


def parse_question(body):
    question, scope = body.get("question"), body.get("scope", "none")
    if not isinstance(question, str) or not 0 < len(question.strip()) <= 2000:
        raise GeminiError(400, "질문을 1~2,000자로 입력해 주세요.")
    try:
        question.encode()
    except UnicodeError:
        raise GeminiError(400, "질문의 문자 형식을 확인해 주세요.") from None
    if not isinstance(scope, str) or scope not in SCOPES:
        raise GeminiError(400, "참고할 기록 범위를 확인해 주세요.")
    return question.strip(), scope


def summarize_records(scope, items, today):
    if scope == "shopping":
        completed = sum(item.get("done") == "yes" for item in items)
        return {"completed": completed, "pending": len(items) - completed}

    first = today - timedelta(days=6) if scope == "feeding" else today
    days = {(first + timedelta(days=index)).isoformat(): {"count": 0} for index in range(7)}
    for item in items:
        day = days.get(item.get("date", "")[:10])
        if day is None or (scope == "feeding" and item.get("type") != "feeding"):
            continue
        day["count"] += 1
        if scope == "feeding":
            match = VOLUME.fullmatch(item.get("amount", "").strip())
            if match and (ml := float(match[1])) <= 1_000_000:
                day["measured_count"] = day.get("measured_count", 0) + 1
                day["volume_ml"] = day.get("volume_ml", 0) + ml
    if scope == "feeding":
        for day in days.values():
            day["measured_count"] = day.get("measured_count", 0)
            day["volume_ml"] = round(day.get("volume_ml", 0), 2)
    return days


class Gemini:
    def __init__(self, key="", allow_summaries=False):
        self.key = key
        self.allow_summaries = bool(key) and allow_summaries
        self.lock = threading.Lock()
        self.active = set()
        self.attempts = defaultdict(deque)

    @classmethod
    def load(cls, directory):
        path = directory / CONFIG_NAME
        try:
            if path.stat().st_mode & 0o077:
                return cls()
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        if not isinstance(config, dict) or not valid_key(config.get("apiKey")):
            return cls()
        return cls(config["apiKey"], config.get("allowRecordSummaries") is True)

    def status(self):
        return {"enabled": bool(self.key), "model": MODEL, "recordSummaries": self.allow_summaries}

    def answer(self, username, question, scope, summary):
        with self.lock:
            now = time.monotonic()
            attempts = self.attempts[username]
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if username in self.active or len(attempts) >= 6:
                raise GeminiError(429, "질문 요청이 많아요. 잠시 후 다시 시도해 주세요.")
            self.active.add(username)
            attempts.append(now)
        try:
            return self.generate(question, scope, summary)
        finally:
            with self.lock:
                self.active.remove(username)

    def generate(self, question, scope, summary):
        parts = [{"text": question}]
        if summary is not None:
            parts.append({"text": "선택한 가족 기록 집계: " + json.dumps(
                {"scope": scope, "summary": summary}, ensure_ascii=False)})
        request = {
            "systemInstruction": {"parts": [{"text": SYSTEM}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"maxOutputTokens": 1024},
            "store": False,
        }
        connection = http.client.HTTPSConnection("generativelanguage.googleapis.com", timeout=DEADLINE_SECONDS)
        expired = threading.Event()
        response_socket = None
        response = None

        def stop():
            # A socket timeout only bounds each read, so a slowly dripping reply
            # could keep going. Shutting the socket down interrupts a blocked read.
            expired.set()
            sock = response_socket or getattr(connection, "sock", None)
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        watchdog = threading.Timer(DEADLINE_SECONDS, stop)
        watchdog.daemon = True
        watchdog.start()
        try:
            connection.request("POST", f"/v1beta/models/{MODEL}:generateContent", json.dumps(request), {
                "Content-Type": "application/json",
                "x-goog-api-key": self.key,
            })
            # getresponse() detaches the socket when the peer sends Connection: close.
            response_socket = connection.sock
            if expired.is_set():
                raise TimeoutError
            response = connection.getresponse()
            if expired.is_set():
                raise TimeoutError
            if response.status == 429:
                raise GeminiError(429, "Gemini 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.")
            if response.status in (401, 403):
                raise GeminiError(503, "Gemini 인증을 확인해 주세요. 관리자 설정이 필요해요.")
            if response.status != 200:
                raise GeminiError(502, "Gemini가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.")
            body = response.read(256 * 1024)
            if expired.is_set():
                raise TimeoutError
            data = json.loads(body)
            candidate = data["candidates"][0]
            finish = candidate.get("finishReason", "STOP")
            answer = "\n".join(part["text"] for part in candidate["content"]["parts"]
                               if isinstance(part.get("text"), str) and not part.get("thought")).strip()
            answer.encode()
        except TimeoutError:
            raise GeminiError(504, "Gemini 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.") from None
        except (OSError, http.client.HTTPException):
            if expired.is_set():
                raise GeminiError(504, "Gemini 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.") from None
            raise GeminiError(502, "Gemini에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.") from None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            if expired.is_set():
                raise GeminiError(504, "Gemini 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.") from None
            raise GeminiError(502, "Gemini가 표시할 수 있는 답변을 보내지 않았어요.") from None
        finally:
            watchdog.cancel()
            if response is not None:
                response.close()
            connection.close()
        if not answer or finish not in ("STOP", "MAX_TOKENS"):
            raise GeminiError(502, "Gemini가 표시할 수 있는 답변을 보내지 않았어요.")
        return {"answer": answer, "truncated": finish == "MAX_TOKENS"}
