"""Install this checkout's local API as a per-user macOS LaunchAgent."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
data = Path.home() / "Library/Application Support/Somhouse"
if not (data / "somhouse.sqlite3").is_file():
    raise SystemExit("먼저 python3 server.py init 을 실행해 주세요.")
label = "com.ssoomm.somhouse"
target = Path.home() / "Library/LaunchAgents" / (label + ".plist")
target.parent.mkdir(parents=True, exist_ok=True)
configuration = {
    "Label": label,
    "ProgramArguments": [sys.executable, str(root / "server.py"), "serve", "--origin", "https://ssoomm-main.tail31d445.ts.net"],
    "WorkingDirectory": str(root),
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "Umask": 0o077,
    "StandardOutPath": str(data / "service.log"),
    "StandardErrorPath": str(data / "service-error.log"),
}
domain = f"gui/{os.getuid()}"
if target.exists():
    previous = plistlib.loads(target.read_bytes())
    if previous.get("Label") != label or previous.get("ProgramArguments", [None, None])[1] != str(root / "server.py"):
        raise SystemExit("다른 서비스 설정이 있습니다. 덮어쓰지 않았습니다.")
    subprocess.run(["launchctl", "bootout", domain, str(target)], check=False, capture_output=True)
temporary = target.with_suffix(".plist.tmp")
temporary.write_bytes(plistlib.dumps(configuration))
temporary.chmod(0o600)
temporary.replace(target)
subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
print("솜하우스 자동 실행 설치 완료: http://127.0.0.1:8787/")
print("프로세스 종료 시 재실행하며, 맥 사용자 로그인 시 시작합니다.")
