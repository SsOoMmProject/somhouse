"""Authorize the Google records bridge in the Mac administrator's browser."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google_records import GoogleAPI, GoogleError, SCOPES, TASKS, load_config, read_config
from calendar_records import CALENDAR_NAME, CALENDAR_SCOPES, CALENDAR_WEB, WRITE_SCOPE
from google_setup import provision
from server import DEFAULT_DATA


def authorize(client_file, calendar=False, *, open_browser=True):
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        raise SystemExit("전용 Python 환경에 google-auth-oauthlib를 설치해 주세요.") from None
    client = json.loads(client_file.read_text(encoding="utf-8"))
    installed = client.get("installed") if isinstance(client, dict) else None
    if not isinstance(installed, dict) or installed.get("auth_uri") not in (
        "https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"
    ) or installed.get("token_uri") != "https://oauth2.googleapis.com/token":
        raise SystemExit("Google Cloud에서 다운로드한 데스크톱 앱용 OAuth JSON을 지정해 주세요.")
    scopes = SCOPES + CALENDAR_SCOPES if calendar else SCOPES
    flow = InstalledAppFlow.from_client_config(client, scopes, autogenerate_code_verifier=True)
    credentials = flow.run_local_server(
        host="127.0.0.1", port=0, timeout_seconds=300, open_browser=open_browser,
        prompt="consent select_account", access_type="offline",
        authorization_prompt_message="네스트가 쓰는 계정으로 로그인해 주세요. 창이 열리지 않으면 이 맥에서 {url}을 여세요.",
        success_message="Google 동의가 완료되었습니다. 솜하우스 터미널에서 연결 확인이 진행됩니다.",
    )
    if not credentials.refresh_token:
        raise SystemExit("Google이 오프라인 연결 권한을 주지 않았습니다. 다시 연결해 주세요.")
    return credentials


def configure(directory, client_file, inbox=None, calendar=False, *, open_browser=True):
    previous = read_config(directory) or {}
    calendar = calendar or bool(previous.get("calendar_outbox"))
    credentials = authorize(client_file, calendar, open_browser=open_browser)
    config = {**previous, "binding": previous.get("binding", secrets.token_hex(16)),
              "client_id": credentials.client_id, "client_secret": credentials.client_secret,
              "refresh_token": credentials.refresh_token, "inbox": inbox or previous.get("inbox", "@default")}
    api = GoogleAPI(config, credentials.token)
    identity = api.request("https://openidconnect.googleapis.com/v1/userinfo", service="Google 계정")
    subject = identity.get("sub")
    if not subject or identity.get("email_verified") is not True:
        raise SystemExit("이메일이 확인된 Google 계정으로 연결해 주세요.")
    if previous.get("subject") and previous["subject"] != subject:
        raise SystemExit("기존 연동과 같은 Google 계정으로 다시 로그인해 주세요.")
    config["subject"] = subject
    if calendar:
        # Writeback stays off unless Google actually granted the read/write Calendar scope.
        granted = set(getattr(credentials, "granted_scopes", None) or credentials.scopes or ())
        config["calendar_write"] = WRITE_SCOPE in granted
    if config["inbox"] == config.get("task_list"):
        raise SystemExit("음성 입력 목록과 웹 기록 목록은 서로 달라야 합니다.")
    provision(directory, api, config, calendar)
    print(f"연결 계정 {identity.get('email', '')} · 음성 목록 {config['inbox']}")
    print(f"원본 시트 https://docs.google.com/spreadsheets/d/{config['spreadsheet']}/edit")
    if calendar:
        print(f"수유 캘린더 {CALENDAR_NAME} · {CALENDAR_WEB}")
    print("솜하우스 서버를 다시 시작하면 동기화가 시작됩니다.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", type=Path, help="Google Cloud에서 받은 데스크톱 앱 OAuth JSON")
    parser.add_argument("--inbox", help="Google Tasks 음성 입력 목록 ID. 기본값은 @default")
    parser.add_argument("--calendar", action="store_true", help="수유용 Google Calendar 읽기와 전용 캘린더 추가")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않고 승인 주소만 출력")
    parser.add_argument("--list-inboxes", action="store_true", help="연결한 계정의 Tasks 목록 이름과 ID 출력")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.list_inboxes:
            config = load_config(args.data_dir)
            if not config:
                parser.error("먼저 Google 계정을 연결해 주세요.")
            for task_list in GoogleAPI(config).pages(TASKS + "users/@me/lists", maxResults=100):
                print(f"{task_list['title']} · {task_list['id']}")
        else:
            if not args.client:
                parser.error("--client에 데스크톱 앱용 OAuth JSON 파일을 지정해 주세요.")
            args.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            configure(args.data_dir, args.client, args.inbox, args.calendar, open_browser=not args.no_browser)
    except GoogleError as error:
        parser.exit(1, f"Google 연결을 확인하지 못했습니다. 응답 {error}.\n")
    except (OSError, ValueError, KeyError):
        parser.exit(1, "설정 파일을 읽거나 저장하지 못했습니다. 파일과 접근 권한을 확인해 주세요.\n")
    except Exception as error:
        parser.exit(1, f"Google 연결을 마치지 못했습니다. 브라우저의 승인 결과를 확인해 주세요 ({type(error).__name__}).\n")


if __name__ == "__main__":
    main()
