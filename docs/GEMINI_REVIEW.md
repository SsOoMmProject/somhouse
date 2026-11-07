# 솜하우스 Gemini 연동 검토

## 저장소와 기준

- 저장소는 https://github.com/SsOoMmProject/somhouse 이다.
- 운영 기준은 `main`의 `aa89310`이다.
- AI 검토 대상은 `feature/gemini` 브랜치다.
- 수정할 LLM마다 `origin/feature/gemini`에서 `review/claude-gemini`, `review/gpt-gemini` 등 독립 브랜치를 만든다. 검토 결과와 변경 이유, 실행한 테스트를 함께 남긴다.

```sh
git clone https://github.com/SsOoMmProject/somhouse.git
cd somhouse
git switch -c review/claude-gemini origin/feature/gemini
git diff origin/main...HEAD
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

## 기존 서비스

가족의 수유·병원·일정·구매 기록을 관리하는 모바일 웹앱이다. GitHub Pages의 HTML/CSS/일반 JavaScript가 맥미니의 Python 표준 라이브러리 HTTP API에 연결된다. SQLite가 공유 기록을 보관하고 Tailscale Funnel이 외부 HTTPS를 제공한다.

가족 두 계정이 같은 저장소를 사용하며 로그인 상태는 브라우저에 보관한 Bearer 토큰으로 유지한다. 서버에는 토큰의 해시를 보관한다. 비밀번호 변경 시 변경한 세션을 유지하고 같은 계정의 다른 세션을 해제한다.

앱은 다른 기기의 변경을 2초마다 확인한다. 편집 중 입력 유지와 기존 브라우저 기록의 원본 보존이 필요하다. 변경 전 자동 백업과 관리자 CLI 복원을 제공한다.

## 이번 구현

- 기본 공급자는 사용자 선택에 따라 Gemini다. 구체 모델은 구현 시 `gemini-3.5-flash-lite`로 정했다.
- `gemini.py`가 고정 Google HTTPS 주소의 `generateContent`를 호출한다. 키는 요청 헤더로 보낸다.
- `python3 server.py gemini-key`가 터미널에서 입력받은 전용 키를 운영 데이터 폴더의 `gemini-config.json`에 권한 `0600`으로 저장한다.
- 인증된 `GET /api/ai`가 설정 상태를 조회하고 `POST /api/ai`가 질문에 답한다.
- 기본 설정은 질문만 전송한다. 관리자가 `--allow-record-summaries`를 설정한 경우 사용자가 질문마다 수유·일정·구매 중 한 종류의 집계를 고른다.
- 집계는 날짜·횟수·수유량·구매 상태별 건수로 제한한다. 수유 집계는 오늘까지 7일, 일정은 오늘부터 7일이며 기준 날짜는 서버의 현지 날짜다. 수유량은 명시적 ml 단위와 1,000,000ml 이하의 값만 합산한다.
- 질문마다 독립적으로 생성한다. 질문과 답변은 현재 화면 메모리에 표시한다.
- 계정별 동시 요청 1개와 분당 6회 제한, 18초 Google 연결 제한, 최대 출력 1,024토큰을 적용한다.
- UI는 대기와 실패를 표시하고 실패 시 입력을 유지한다. 답변은 일반 텍스트로 표시한다.
- 로그아웃으로 AI 상태를 초기화하고, 이미 전송된 요청의 응답이 늦게 도착해도 이전 상태에만 귀속한다.

## 검토할 부분

1. 인증·출처 검사와 키 파일 권한, 정적 파일 제공 범위를 확인한다.
2. 원본 기록의 자유 텍스트가 전송 payload에 섞이는지 확인한다. 집계 입력의 오래된 값·잘못된 날짜·단위 없는 수유량을 검토한다.
3. AI 응답 대기 동안 SQLite 잠금이 해제되는지, 기록 저장과 자동 갱신이 정상인지 확인한다.
4. Gemini의 429·인증 오류·시간 초과·빈 답변·응답 차단을 검토한다.
5. 화면 전환·입력 중 갱신·로그아웃과 진행 중 응답의 경합을 검토한다.
6. 출력 XSS와 토큰·키·개인 기록의 오류 메시지 노출을 확인한다.
7. 실제 API 호출 전에 전용 키, 프로젝트의 요금제와 이용 조건, 모델 사용 가능 여부를 확인한다.

## 검증과 남은 연결 단계

JavaScript 22개와 Python 16개 테스트가 통과했다. Gemini 응답은 모의 HTTPS 응답으로 검증했다. 실제 Gemini 키 설정과 실응답 확인, 실제 휴대폰 화면 검증이 남아 있다.

로컬 운영 체크아웃에는 이전 Nest 검토 내용이 포함된 미커밋 `docs/SERVICE_PLAN.md`가 있다. 이 작업은 별도 worktree에서 수행했다. 병합 시 해당 계획 내용도 함께 확인한다.

## 공식 참고 자료

- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [generateContent API](https://ai.google.dev/api/generate-content)
- [API 키](https://ai.google.dev/gemini-api/docs/api-key)
- [이용 조건](https://ai.google.dev/gemini-api/terms)
- [가격](https://ai.google.dev/gemini-api/docs/pricing)
