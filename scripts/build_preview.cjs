// Builds preview.html: every screen pre-rendered with the guest's made-up records, readable without login or JavaScript.
// Usage: node scripts/build_preview.cjs   (writes preview.html in the repository root)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {browser} = require('../tests/helpers/browser.cjs');

const root = path.resolve(__dirname, '..');
const payload = JSON.parse(execFileSync('python3', ['-c', 'import json,demo;print(json.dumps(demo.demo_payload(),ensure_ascii=False))'], {cwd: root}));
const fetcher = async url => {
  const result = url.endsWith('/api/login') ? {token: 'preview', username: 'guest', read_only: true} : payload;
  return {ok: true, json: async () => result};
};

(async () => {
  const b = browser({fetcher});
  await b.login('guest');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const nav = index.match(/<nav[^>]*>[\s\S]*?<\/nav>/)[0].replace(' hidden', '');
  const ai = index.match(/<section id="ai-panel"[\s\S]*?<\/section>/)[0].replace(' hidden', '').replace('<p id="ai-status" role="status"></p>', '<p id="ai-status" role="status">가족 계정으로 로그인하면 내 ChatGPT 구독의 연결 상태를 확인할 수 있어요.</p>');
  const today = b.eval('Somhouse.localDateTime()');
  const screen = (title, note, page, extra = '') => {
    b.eval(`page=${JSON.stringify(page)};render()`);
    const active = nav.replace(`data-page="${page}">`, `data-page="${page}" class="active" aria-current="page">`);
    const board = page === 'schedule' ? `<section id="dashboard">${b.get('#dashboard').innerHTML}</section>` : '';
    const card = page === 'home' ? header.replace('</section>', `<div id="google-status">${b.get('#google-status').innerHTML}</div></section>`) : '';
    return `<article class="preview-screen" id="screen-${page}"><h2 class="preview-title">${title}</h2><p class="preview-note">${note}</p><div class="phone"><main>${card}${active}${board}<div id="content">${b.get('#content').innerHTML}</div>${extra}</main></div></article>`;
  };
  const form = (type, title, note) => {
    b.eval(`openForm(${JSON.stringify(type)})`);
    const html = `<article class="preview-screen" id="form-${type}"><h2 class="preview-title">${title}</h2><p class="preview-note">${note}</p><div class="phone"><div class="dialog"><div class="formhead"><h2>${b.get('#formtitle').textContent}</h2><button type="button" class="plain">✕</button></div>${b.get('#fields').innerHTML}<div class="actions"><button type="button" class="secondary">취소</button><button type="button">저장하기</button></div></div></div></article>`;
    b.get('#dialog').open = false;
    return html;
  };
  const header = `<section class="card connection"><div class="heading"><h2>가족 기록 · family1</h2><div class="account-actions"><button type="button" class="plain">비밀번호 변경</button><button type="button" class="plain">로그아웃</button></div></div><p>기록은 자동으로 저장되고 가족과 함께 업데이트돼요.</p></section>`;
  b.eval(`calendarDay=${JSON.stringify(today.slice(0, 10))}`);
  const screens = [
    screen('1. 홈', '로그인 직후 첫 화면. 맨 위에 얇은 계정 줄, 휴대폰에서는 메뉴가 화면 아래 고정 탭 바(홈·기록·통계·일정·구매·AI)입니다. 순서: 지금 아기 상태(마지막 수유 경과 시간, 마지막 수면 ‘깬 지 N분’, 수면 시작 버튼 — 자는 중에는 ‘☀️ 수면 종료’로 바뀌고 수유를 기록해도 수면이 끝남) → 빠른 기록 → 최근 수유 다시 기록 → ⚠️ 확인할 것(종류만 고르면 되는 기록 + 저장하지 못한 음성 입력) → 다가오는 일정·구매 예정·최근 기록 → 기간별 요약(주 단위는 하루 평균) → 맨 아래 Google 연동 한 줄(문제가 있으면 맨 위 경고로 바뀜).', 'home'),
    screen('2. 육아 기록', '날짜별로 묶고 하루 소계를 붙인 목록(기본 최근 3일, ‘이전 기록 더 보기’). 카드를 누르면 수정창이 열리고 삭제는 그 안에 있습니다. 필터는 고르는 즉시 적용. 맨 아래 음성·캘린더 입력 도움말.', 'records'),
    screen('3. 수유 통계', '7일/30일 선택, 하루 평균 횟수·용량, 평균 수유 간격, 기간 합계, 일별 횟수·용량 표(막대는 옆 칸 수치의 시각화).', 'stats'),
    screen('4. 일정', '월간 가족 달력(수유·일정·수면·구매·Google 캘린더, 공휴일 빨간 글씨)은 이 화면에만 있습니다. 오늘 날짜를 누른 상태. 아래 목록은 ‘다가오는 N · 지난 M’, 가까운 순, D-day 배지(오늘·내일·D-n), 지난 일정은 접힘. 입력 항목: 날짜와 시간·누구 일정·일정 이름·장소·메모.', 'schedule'),
    screen('5. 구매 목록', '‘살 것 N · 산 것 M’. 예정일이 가까운 순, 날짜 없는 항목은 그 아래. ‘✓ 샀어요’ 한 번으로 완료, 산 것은 접혀 있고 ‘다시 사기’로 되돌림. 수량 기본값 1.', 'shopping'),
    screen('6. (메뉴 없음) 확인 필요 전체 보기', '메뉴 탭이 아닙니다. 홈 ‘확인할 것’에 3건 넘게 쌓였을 때 ‘나머지 보기’로 들어오는 화면입니다. 음성(Nest → Google Tasks)이나 Google 캘린더로 들어왔지만 자동 저장하지 못한 입력을 정정합니다.', 'review'),
    `<article class="preview-screen" id="screen-ai"><h2 class="preview-title">7. AI 대화</h2><p class="preview-note">내 ChatGPT 구독, 개인 API 키 또는 관리자가 연결한 AI로 질문하는 화면입니다.</p><div class="phone"><main>${nav.replace('data-page="ai">', 'data-page="ai" class="active">')}${ai}</main></div></article>`,
    form('feeding', '8. 입력창 · 수유 기록', '날짜와 시간은 지금으로 채워짐. 분유·혼합은 ml, 모유는 분 단위가 고정되고 숫자만 입력하거나 ±10ml/±5분 버튼으로 조절. 기본값은 같은 종류의 직전 양. 기타만 자유 입력.'),
    form('sleep', '9. 입력창 · 수면 기록', '수기 입력용. 보통은 홈의 수면 시작/종료 버튼을 쓰며, 수면 중 수유를 기록하면 수면이 자동으로 끝납니다.'),
    form('hospital', '10. 입력창 · 병원 방문', ''),
    form('schedule', '11. 입력창 · 일정', ''),
    form('shopping', '12. 입력창 · 구매 물품', ''),
  ];
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>솜하우스 화면 미리보기 (예시 데이터)</title><link rel="stylesheet" href="style.css">
<style>body{background:#e9e6de}.preview-intro{max-width:860px;margin:24px auto;padding:0 20px}.preview-intro li{line-height:1.7}.preview-screen{max-width:430px;margin:40px auto;padding:0 12px}.preview-title{font-size:22px}.preview-note{font-size:14px}.phone{background:#f8f5ef;border:1px solid #d6d2c6;border-radius:28px;overflow:hidden;padding-top:8px}.phone main{padding:16px}.dialog{background:#fff;margin:16px;border-radius:20px;padding:24px}nav{display:flex;gap:8px;overflow-x:auto;padding-bottom:12px}</style></head>
<body><header><div><span class="logo">✿</span> <strong>솜하우스</strong><small>우리 가족의 작은 기록 · 화면 미리보기</small></div></header>
<section class="preview-intro"><h1>솜하우스 화면 미리보기</h1>
<p>가족 육아 기록 모바일 웹앱 <a href="https://ssoommproject.github.io/somhouse/">솜하우스</a>의 모든 화면을 로그인·JavaScript 없이 읽을 수 있게 미리 그린 페이지입니다. 실제 앱 코드(app.js)로 그렸고, 기록은 모두 <strong>가짜 예시 데이터</strong>입니다. 버튼은 동작하지 않습니다. 생성 시각: ${today.replace('T', ' ')} (Asia/Seoul).</p>
<ul><li>사용자: 부모 2명이 각자 휴대폰으로 같은 가족 기록을 공유(자동 저장, 2초마다 다른 휴대폰 변경 반영).</li><li>입력 경로: 웹 버튼·입력창, Nest Hub 음성(Google Tasks 경유), Google 캘린더 일정 제목.</li><li>화면 폭 기준: 휴대폰 360~430px.</li><li>모든 화면 맨 위(헤더 아래)에는 계정 카드가 있습니다: ${header.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}</li></ul>
<p>목차: ${screens.map(x => x.match(/id="([^"]+)"><h2 class="preview-title">([^<]+)/)).map(([, id, t]) => `<a href="#${id}">${t}</a>`).join(' · ')}</p></section>
${screens.join('\n')}
</body></html>
`;
  fs.writeFileSync(path.join(root, 'preview.html'), html);
  console.log('preview.html', html.length, 'bytes');
})();
