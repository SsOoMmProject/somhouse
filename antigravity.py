"""Run Antigravity CLI with a single question and limited record summaries."""
from collections import defaultdict, deque
from datetime import timedelta
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time

CONFIG_NAME = "antigravity-config.json"
MODEL = "gemini-3.8-flash-medium"
# Leave time for the server to send its error before the browser times out.
DEADLINE_SECONDS = 20
MAX_OUTPUT_BYTES = 256 * 1024
MAX_ANSWER_LENGTH = 8000
SANDBOX = Path("/usr/bin/sandbox-exec")
SETTINGS = json.dumps({
    "agentMode": "plan",
    "allowNonWorkspaceAccess": False,
    "historySize": 0,
    "modelProvider": "",
    "toolPermission": "strict",
    "useG1Credits": False,
    "permissions": {"allow": [], "ask": [], "deny": [
        "command(*)", "read_file(*)", "write_file(*)", "read_url(*)",
        "execute_url(*)", "mcp(*)", "unsandboxed(*)",
    ]},
})
SCOPES = {"none": None, "feeding": "records", "schedule": "schedule", "shopping": "shopping"}
VOLUME = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:ml|미리|밀리리터)", re.IGNORECASE)
SYSTEM = (
    "솜하우스의 가족 기록 도우미로 한국어로 간결하게 답하세요. "
    "제공된 집계의 날짜, 건수, 수유량만 근거로 삼고 누락된 기록이나 세부 내용을 지어내지 마세요. "
    "수유량 합계는 ml가 명시된 기록만 포함합니다. 가족 기록 질문에 필요한 집계가 없으면 이를 알리세요. "
    "기록을 생성하거나 변경했다고 말하지 마세요. 의료 진단이나 처방을 제공하지 마세요."
)


class AntigravityError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def executable(value):
    if not isinstance(value, str):
        return None
    path = Path(value)
    if path.is_absolute() and path.is_file() and os.access(path, os.X_OK):
        return path
    return None


def save_config(directory, binary, allow_summaries):
    descriptor, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump({"binary": str(binary), "allowRecordSummaries": allow_summaries}, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, directory / CONFIG_NAME)
    finally:
        Path(temporary).unlink(missing_ok=True)


def parse_question(body):
    question, scope = body.get("question"), body.get("scope", "none")
    if not isinstance(question, str) or not 0 < len(question.strip()) <= 2000:
        raise AntigravityError(400, "질문을 1~2,000자로 입력해 주세요.")
    try:
        question.encode()
    except UnicodeError:
        raise AntigravityError(400, "질문의 문자 형식을 확인해 주세요.") from None
    if not isinstance(scope, str) or scope not in SCOPES:
        raise AntigravityError(400, "참고할 기록 범위를 확인해 주세요.")
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


class Antigravity:
    def __init__(self, directory, binary=None, allow_summaries=False):
        self.directory = directory.resolve()
        self.binary = binary
        self.allow_summaries = bool(binary) and allow_summaries
        self.lock = threading.Lock()
        self.active = set()
        self.attempts = defaultdict(deque)

    @classmethod
    def load(cls, directory):
        path = directory / CONFIG_NAME
        try:
            if path.stat().st_mode & 0o077:
                return cls(directory)
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls(directory)
        if not isinstance(config, dict):
            return cls(directory)
        binary = executable(config.get("binary"))
        if binary is None or not SANDBOX.is_file():
            return cls(directory)
        return cls(directory, binary, config.get("allowRecordSummaries") is True)

    def status(self):
        return {"enabled": bool(self.binary), "model": MODEL, "recordSummaries": self.allow_summaries}

    def answer(self, username, question, scope, summary):
        with self.lock:
            now = time.monotonic()
            attempts = self.attempts[username]
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if username in self.active or len(attempts) >= 6:
                raise AntigravityError(429, "질문 요청이 많아요. 잠시 후 다시 시도해 주세요.")
            self.active.add(username)
            attempts.append(now)
        try:
            return self.generate(question, scope, summary)
        finally:
            with self.lock:
                self.active.remove(username)

    def command(self, log):
        # The CLI can load global customizations at startup, before processing
        # a prompt. Keep it away from those files, the app and the family DB.
        profile = Path.home() / ".gemini"
        blocked = [self.directory, Path(__file__).resolve().parent]
        blocked.extend(profile / name for name in (
            "config", "AGENTS.md", "GEMINI.md", "settings.json", "mcp_config.json",
            "extensions", "skills", "commands", "antigravity-cli/mcp_config.json",
        ))
        paths = " ".join("(subpath " + json.dumps(str(path), ensure_ascii=False) + ")" for path in blocked)
        policy = "(version 1) (allow default) (deny file-read* file-write* " + paths + ")"
        return [str(SANDBOX), "-p", policy, str(self.binary), "--input-format", "stream-json",
                "--output-format", "stream-json", "--disable-slash-commands", "--settings", SETTINGS,
                "--model", MODEL, "--print-timeout", f"{DEADLINE_SECONDS:g}s",
                "--log-file", str(log)]

    def generate(self, question, scope, summary):
        context = {"question": question}
        if summary is not None:
            context["records"] = {"scope": scope, "summary": summary}
        prompt = SYSTEM + "\n" + json.dumps(context, ensure_ascii=False)
        message = json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
        # Inherit the same macOS account for Keychain. Pass only the environment
        # variables needed by the CLI and Google Cloud credential discovery.
        environment = {name: os.environ[name] for name in (
            "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT", "AGY_ADC_AUTH",
        ) if name in os.environ}
        environment.update(PATH=os.defpath, AGY_CLI_DISABLE_AUTO_UPDATE="true")
        try:
            with (tempfile.TemporaryDirectory(prefix="somhouse-agy-") as workspace,
                  tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as diagnostics):
                log = Path(workspace) / "agy.log"
                with subprocess.Popen(self.command(log), cwd=workspace, env=environment,
                                      stdin=subprocess.PIPE, stdout=output, stderr=diagnostics,
                                      start_new_session=True) as process:
                    try:
                        process.communicate(message.encode(), timeout=DEADLINE_SECONDS)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                        raise AntigravityError(504, "AI 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.") from None
                    output.seek(0)
                    payload = output.read(MAX_OUTPUT_BYTES + 1)
                    diagnostics.seek(0)
                    error = diagnostics.read(16 * 1024)
                    if process.returncode and log.is_file():
                        with log.open("rb") as file:
                            error += b"\n" + file.read(16 * 1024)
                    return decode_answer(payload, process.returncode, error.decode(errors="replace"))
        except OSError:
            raise AntigravityError(503, "맥미니에서 Antigravity CLI를 실행할 수 없어요. 관리자 설정을 확인해 주세요.") from None


def decode_answer(payload, returncode, diagnostics):
    result = {}
    try:
        if len(payload) <= MAX_OUTPUT_BYTES:
            for line in payload.splitlines():
                event = json.loads(line)
                if event.get("event") == "result":
                    result = event["result"]
        if result.get("status") == "SUCCESS" and not returncode:
            answer = result["response"].strip()
            answer.encode()
            if answer:
                return {"answer": answer[:MAX_ANSWER_LENGTH], "truncated": len(answer) > MAX_ANSWER_LENGTH}
    except (ValueError, AttributeError, KeyError, TypeError):
        result = {}
    error = (str(result.get("error", "")) + "\n" + diagnostics).lower()
    if any(message in error for message in ("authentication required", "not authenticated", "sign in to", "unauthorized")):
        raise AntigravityError(503, "맥미니의 Antigravity CLI 로그인을 확인해 주세요.")
    if any(message in error for message in ("quota", "rate limit", "resource_exhausted")):
        raise AntigravityError(429, "AI 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.")
    if any(message in error for message in ("deadline exceeded", "timed out", "print timeout")):
        raise AntigravityError(504, "AI 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.")
    raise AntigravityError(502, "Antigravity CLI 답변을 받지 못했어요. 관리자 설정을 확인해 주세요.")
