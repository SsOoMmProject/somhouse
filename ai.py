"""Ask one connected AI CLI (Codex, Claude or Antigravity) a single question with limited record summaries."""
from contextlib import contextmanager
from collections import defaultdict, deque
from datetime import timedelta
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

CONFIG_NAME = "ai-config.json"
# Written by the single-provider version; still read so an existing setup keeps working.
LEGACY_CONFIG_NAME = "antigravity-config.json"
# Leave time for the server to send its error before the browser times out.
DEADLINE_SECONDS = 45
# Antigravity enforces the same limit itself. Wait a little longer so that its own
# timeout report or a late exit after the answer arrives before the kill.
EXIT_GRACE_SECONDS = 3
MAX_OUTPUT_BYTES = 256 * 1024
MAX_ANSWER_LENGTH = 8000
SANDBOX = Path("/usr/bin/sandbox-exec")
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}")
SCOPES = {"none": None, "feeding": "records", "schedule": "schedule", "shopping": "shopping"}
VOLUME = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:ml|미리|밀리리터)", re.IGNORECASE)
SYSTEM = (
    "솜하우스의 가족 도우미로 한국어로 간결하게 답하세요. "
    "육아 상식, 제품 고르는 기준 같은 일반 질문은 알고 있는 지식으로 답하세요. "
    "최신 리뷰 순위, 가격, 재고 같은 실시간 정보는 확인할 수 없다고 짧게 밝히고, 알고 있는 범위의 정보와 고르는 기준을 안내하세요. "
    "가족 기록 질문은 제공된 집계의 날짜, 건수, 수유량만 근거로 삼고 누락된 기록이나 세부 내용을 지어내지 마세요. "
    "수유량 합계는 ml가 명시된 기록만 포함합니다. 가족 기록 질문에 필요한 집계가 없으면 이를 알리세요. "
    "기록을 생성하거나 변경했다고 말하지 마세요. 의료 진단이나 처방은 하지 말고 필요하면 소아과 상담을 권하세요."
)
# Inherit the same macOS account for Keychain logins. Never pass API keys or the server's own settings.
BASE_ENVIRONMENT = ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG")


class AIError(Exception):
    def __init__(self, status, message, detail=""):
        self.status, self.message, self.detail = status, message, detail


def executable(value):
    if not isinstance(value, str):
        return None
    path = Path(value)
    if path.is_absolute() and path.is_file() and os.access(path, os.X_OK):
        return path
    return None


def private_json(path):
    """A JSON object from a file only its owner can read, or None."""
    try:
        if path.stat().st_mode & 0o077:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def read_config(directory):
    config = {name: entry for name, entry in (private_json(directory / CONFIG_NAME) or {}).items()
              if isinstance(entry, dict)}
    if "antigravity" not in config and (legacy := private_json(directory / LEGACY_CONFIG_NAME)):
        config["antigravity"] = legacy
    return config


def write_config(directory, config):
    descriptor, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(config, file, ensure_ascii=False, indent=1)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, directory / CONFIG_NAME)
    finally:
        Path(temporary).unlink(missing_ok=True)


def save_config(directory, provider, binary, allow_summaries, model=None):
    """Connect one provider. The others keep their settings."""
    config = read_config(directory)
    entry = {"binary": str(binary), "allowRecordSummaries": allow_summaries}
    if model:
        entry["model"] = model
    config[provider] = entry
    write_config(directory, config)
    (directory / LEGACY_CONFIG_NAME).unlink(missing_ok=True)


def remove_config(directory, provider):
    """Disconnect one provider. Returns whether it was connected."""
    config = read_config(directory)
    found = config.pop(provider, None) is not None
    write_config(directory, config)
    (directory / LEGACY_CONFIG_NAME).unlink(missing_ok=True)
    return found


def parse_question(body):
    question, scope = body.get("question"), body.get("scope", "none")
    if not isinstance(question, str) or not 0 < len(question.strip()) <= 2000:
        raise AIError(400, "질문을 1~2,000자로 입력해 주세요.")
    try:
        question.encode()
    except UnicodeError:
        raise AIError(400, "질문의 문자 형식을 확인해 주세요.") from None
    if not isinstance(scope, str) or scope not in SCOPES:
        raise AIError(400, "참고할 기록 범위를 확인해 주세요.")
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


def subpaths(paths):
    return " ".join("(subpath " + json.dumps(str(path), ensure_ascii=False) + ")" for path in paths)


def reply(text):
    if not isinstance(text, str):
        return None
    answer = text.strip()
    answer.encode()
    if not answer:
        return None
    return {"answer": answer[:MAX_ANSWER_LENGTH], "truncated": len(answer) > MAX_ANSWER_LENGTH}


def json_lines(payload):
    """Objects printed one per line. A warning on stdout must not hide the result."""
    if len(payload) > MAX_OUTPUT_BYTES:
        return
    for line in payload.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


class Provider:
    """One AI CLI on the Mac, run once per question in an empty folder and a macOS sandbox."""
    id = name = company = cli = ""
    default_binary = None
    default_model = None
    environment_names = ()
    # The CLI's own instructions, memories, plugins and settings that could change how it answers.
    profile, profile_files = None, ()

    def __init__(self, directory, binary=None, allow_summaries=False, model=None):
        self.directory = Path(directory).resolve()
        self.binary = binary
        self.allow_summaries = bool(binary) and allow_summaries
        self.model = model or self.default_model

    @classmethod
    def from_config(cls, directory, entry):
        entry = entry if isinstance(entry, dict) else {}
        binary = executable(entry.get("binary"))
        if binary is None or not SANDBOX.is_file():
            return cls(directory)
        model = entry.get("model")
        model = model if isinstance(model, str) and MODEL_NAME.fullmatch(model) else None
        return cls(directory, binary, entry.get("allowRecordSummaries") is True, model)

    def status(self):
        return {"id": self.id, "name": self.name, "company": self.company, "enabled": bool(self.binary),
                "model": self.model, "recordSummaries": self.allow_summaries}

    def home(self):
        return (Path.home() / self.profile).resolve()

    def blocked(self):
        """Paths the CLI may neither read nor write: the app, the family data and its customizations."""
        profile = self.home()
        return [self.directory, Path(__file__).resolve().parent, *(profile / name for name in self.profile_files)]

    def policy(self):
        return f"(version 1) (allow default) (deny file-read* file-write* {subpaths(self.blocked())})"

    def command(self, workspace):
        return [str(SANDBOX), "-p", self.policy(), str(self.binary), *self.arguments(workspace)]

    def arguments(self, workspace):
        raise NotImplementedError

    def prompt(self, context):
        return SYSTEM + "\n" + json.dumps(context, ensure_ascii=False)

    def stdin(self, prompt):
        return prompt.encode()

    def environment(self):
        environment = {name: os.environ[name] for name in BASE_ENVIRONMENT + self.environment_names
                       if name in os.environ}
        environment["PATH"] = os.defpath
        return environment

    def logs(self, workspace):
        return []

    def decode(self, payload, returncode, diagnostics, timed_out=False):
        raise NotImplementedError

    def failure(self, detail, timed_out):
        error = detail.lower()
        if timed_out:
            return AIError(504, "AI 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.", detail)
        if any(message in error for message in (
                "invalid model selection", "not recognized as a known model", "model_not_found",
                "model is not supported", "model is not available", "issue with the selected model",
                "unknown model", "does not have access to model")):
            return AIError(503, f"맥미니의 {self.name} 계정에서 설정된 AI 모델을 사용할 수 없어요. 관리자에게 알려 주세요.", detail)
        if any(message in error for message in (
                "authentication required", "not authenticated", "sign in to", "unauthorized", "not logged in",
                "please run /login", "please log in", "invalid api key", "authentication_error", "token expired")):
            return AIError(503, f"맥미니의 {self.name} CLI 로그인을 확인해 주세요.", detail)
        if any(message in error for message in (
                "quota", "rate limit", "rate_limit", "resource_exhausted", "usage limit", "credit balance",
                "too many requests")):
            return AIError(429, "AI 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.", detail)
        if any(message in error for message in ("deadline exceeded", "timed out", "print timeout")):
            return AIError(504, "AI 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.", detail)
        return AIError(502, f"{self.name} 답변을 받지 못했어요. 관리자 설정을 확인해 주세요.", detail)

    def generate(self, question, scope, summary):
        context = {"question": question}
        if summary is not None:
            context["records"] = {"scope": scope, "summary": summary}
        prompt = self.prompt(context)
        try:
            with (tempfile.TemporaryDirectory(prefix=f"somhouse-{self.id}-") as workspace,
                  tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as diagnostics):
                workspace = Path(workspace)
                with subprocess.Popen(self.command(workspace), cwd=workspace, env=self.environment(),
                                      stdin=subprocess.PIPE, stdout=output, stderr=diagnostics,
                                      start_new_session=True) as process:
                    timed_out = False
                    try:
                        process.communicate(self.stdin(prompt), timeout=DEADLINE_SECONDS + EXIT_GRACE_SECONDS)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                    output.seek(0)
                    payload = output.read(MAX_OUTPUT_BYTES + 1)
                    diagnostics.seek(0)
                    error = diagnostics.read(16 * 1024)
                    if timed_out or process.returncode:
                        for log in self.logs(workspace):
                            if log.is_file():
                                with log.open("rb") as file:
                                    error += b"\n" + file.read(16 * 1024)
                    try:
                        return self.decode(payload, process.returncode, error.decode(errors="replace"), timed_out)
                    except AIError as failure:
                        # The service log is the only place an administrator can
                        # see why the CLI failed. Never include the prompt.
                        detail = " ".join(failure.detail.replace(prompt, "").replace(question, "").split())
                        print(f"{self.id}: status={failure.status} exit={process.returncode} "
                              f"timed_out={timed_out} model={self.model or 'default'} {detail[:500]}",
                              file=sys.stderr, flush=True)
                        raise
        except OSError:
            raise AIError(503, f"맥미니에서 {self.name} CLI를 실행할 수 없어요. 관리자 설정을 확인해 주세요.") from None


class Codex(Provider):
    id, name, company, cli = "codex", "Codex", "OpenAI", "codex"
    default_binary = Path.home() / ".local/bin/codex"
    environment_names = ("CODEX_HOME",)
    profile = ".codex"
    profile_files = ("AGENTS.md", "AGENTS.override.md", "config.toml", "rules", "skills", "prompts",
                     "plugins", "memories", "hooks.json")
    # Answer from text only: no shell, browser, plugins, sub-agents, images or web search.
    DISABLED = ("shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation",
                "browser_use", "computer_use", "hooks", "view_image", "tool_suggest", "goals", "skill_search")

    def home(self):
        custom = os.environ.get("CODEX_HOME")
        return Path(custom).resolve() if custom else super().home()

    def arguments(self, workspace):
        arguments = ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
                     "--sandbox", "read-only", "--color", "never", "--json", "--cd", str(workspace),
                     "-c", 'model_reasoning_effort="low"', "-c", 'web_search="disabled"']
        for feature in self.DISABLED:
            arguments += ["--disable", feature]
        if self.model:
            arguments += ["--model", self.model]
        return arguments + ["-"]

    def decode(self, payload, returncode, diagnostics, timed_out=False):
        answer, completed, errors = None, False, []
        for event in json_lines(payload):
            kind = event.get("type")
            item = event.get("item")
            if kind == "item.completed" and isinstance(item, dict) and item.get("type") == "agent_message":
                answer = item.get("text")
            elif kind == "turn.completed":
                completed = True
            elif kind == "error":
                errors.append(str(event.get("message", "")))
            elif kind == "turn.failed":
                error = event.get("error")
                errors.append(str(error.get("message", "") if isinstance(error, dict) else error))
        try:
            if completed and (timed_out or not returncode) and (result := reply(answer)):
                return result
        except UnicodeError:
            pass
        raise self.failure("\n".join(errors) + "\n" + diagnostics, timed_out)


class Claude(Provider):
    id, name, company, cli = "claude", "Claude", "Anthropic", "claude"
    default_binary = Path("/opt/homebrew/bin/claude")
    default_model = "sonnet"
    environment_names = ("CLAUDE_CONFIG_DIR",)
    profile = ".claude"
    profile_files = ("CLAUDE.md", "settings.json", "settings.local.json", "agents", "skills", "commands",
                     "plugins", "hooks", "rules", "output-styles", "projects")

    def home(self):
        custom = os.environ.get("CLAUDE_CONFIG_DIR")
        return Path(custom).resolve() if custom else super().home()

    def arguments(self, workspace):
        # No tools, MCP servers, slash commands or user/project settings; nothing is saved for resume.
        return ["--print", "--output-format", "json", "--tools", "", "--strict-mcp-config",
                "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
                "--model", self.model, "--system-prompt", SYSTEM]

    def prompt(self, context):
        return json.dumps(context, ensure_ascii=False)

    def environment(self):
        return {**super().environment(), "DISABLE_AUTOUPDATER": "1"}

    def decode(self, payload, returncode, diagnostics, timed_out=False):
        result = {}
        for event in json_lines(payload):
            if event.get("type") == "result":
                result = event
        try:
            if (result.get("subtype") == "success" and result.get("is_error") is False
                    and (timed_out or not returncode) and (answer := reply(result.get("result")))):
                return answer
        except UnicodeError:
            pass
        detail = f"{result.get('subtype', '')} {result.get('api_error_status') or ''} {result.get('result', '')}"
        raise self.failure(detail + "\n" + diagnostics, timed_out)


class Antigravity(Provider):
    id, name, company, cli = "antigravity", "Antigravity", "Google", "agy"
    default_binary = Path.home() / ".local/bin/agy"
    default_model = "gemini-3.8-flash-medium"
    environment_names = ("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "AGY_ADC_AUTH")
    profile = ".gemini"
    profile_files = ("AGENTS.md", "GEMINI.md", "settings.json", "mcp_config.json", "extensions", "skills",
                     "commands", "antigravity-cli/mcp_config.json", "antigravity-cli/settings.json")
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

    def policy(self):
        # The CLI needs its default project to start an authenticated session.
        # It can read that file while customizations and writes stay blocked.
        config = self.home() / "config"
        config_path = json.dumps(str(config), ensure_ascii=False)
        default_project = json.dumps(str(config / "projects/default-cli-project.json"), ensure_ascii=False)
        return (
            f"{super().policy()} "
            f"(deny file-write* (subpath {config_path})) "
            f"(deny file-read* (require-all (subpath {config_path}) "
            f"(require-not (literal {default_project}))))"
        )

    def arguments(self, workspace):
        return ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands",
                "--settings", self.SETTINGS, "--model", self.model, "--print-timeout", f"{DEADLINE_SECONDS:g}s",
                "--log-file", str(workspace / "agy.log")]

    def stdin(self, prompt):
        return (json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n").encode()

    def environment(self):
        return {**super().environment(), "AGY_CLI_DISABLE_AUTO_UPDATE": "true"}

    def logs(self, workspace):
        return [workspace / "agy.log"]

    def decode(self, payload, returncode, diagnostics, timed_out=False):
        result = {}
        for event in json_lines(payload):
            if event.get("event") == "result":
                result = event.get("result")
        result = result if isinstance(result, dict) else {}
        # A process stopped after it printed a complete answer still answered.
        try:
            if result.get("status") == "SUCCESS" and (timed_out or not returncode) and (answer := reply(result.get("response"))):
                return answer
        except UnicodeError:
            pass
        raise self.failure(str(result.get("error", "")) + "\n" + diagnostics, timed_out)


PROVIDERS = {kind.id: kind for kind in (Codex, Claude, Antigravity)}


class Assistants:
    """The connected AI CLIs, with one shared per-family-member request limit."""

    def __init__(self, providers):
        self.providers = {provider.id: provider for provider in providers}
        self.lock = threading.Lock()
        self.active = set()
        self.attempts = defaultdict(deque)

    @classmethod
    def load(cls, directory):
        config = read_config(directory)
        return cls(kind.from_config(directory, config.get(name)) for name, kind in PROVIDERS.items())

    def status(self):
        return [provider.status() for provider in self.providers.values()]

    def connected(self):
        return [provider for provider in self.providers.values() if provider.binary]

    @contextmanager
    def slot(self, username):
        with self.lock:
            now = time.monotonic()
            attempts = self.attempts[username]
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if username in self.active or len(attempts) >= 6:
                raise AIError(429, "질문 요청이 많아요. 잠시 후 다시 시도해 주세요.")
            self.active.add(username)
            attempts.append(now)
        try:
            yield
        finally:
            with self.lock:
                self.active.remove(username)

    def answer(self, username, provider, question, scope, summary):
        with self.slot(username):
            return {**provider.generate(question, scope, summary), "provider": provider.id}
