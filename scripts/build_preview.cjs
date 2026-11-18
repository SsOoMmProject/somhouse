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
  const ai = index.match(/<section id="ai-panel"[\s\S]*?<\/section>/)[0].replace(' hidden', '').replace('<fieldset id="ai-fields" disabled>', '<fieldset id="ai-fields">');
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
    screen('1. 홈', '로그인 직후 첫 화면. 상단(모든 화면 공통)에는 아래 계정 카드가 있고, 그 아래 메뉴가 있습니다. ‘지금 아기 상태’ 카드의 수면 시작/종료 버튼, 빠른 기록 버튼, 최근 수유 다시 기록, 종류 확인 상자, 기간별 요약, 최근 기록·다가오는 일정·구매 예정 카드 순서입니다.', 'home'),
    screen('2. 육아 기록', '수유·수면·병원 기록 전체 목록. 검색·종류·기간 필터와 기록별 수정/삭제 버튼.', 'records'),
    screen('3. 수유 통계', '오늘·어제·이번 주·지난주 요약과 최근 7일/30일 일별 수유 횟수·용량 표.', 'stats'),
    screen('4. 일정', '월간 가족 달력(수유·일정·수면·구매·Google 캘린더 표시, 공휴일 빨간 글씨)은 이 화면에만 있습니다. 오늘 날짜를 누른 상태이며, 그 아래 다가오는 일정이 가까운 순, 지난 일정은 접혀 있습니다.', 'schedule'),
    screen('5. 구매 목록', '구매 예정/완료 상태 전환, 수량, 상품 링크.', 'shopping'),
    screen('6. 확인 필요', '음성(Nest → Google Tasks)이나 Google 캘린더로 들어왔지만 자동 저장하지 못한 입력을 정정하는 화면. 홈의 Google 연동 상태에서 들어옵니다.', 'review'),
    `<article class="preview-screen" id="screen-ai"><h2 class="preview-title">7. AI 대화</h2><p class="preview-note">Antigravity CLI(Google)로 질문하는 화면. 관리자가 연결해야 활성화됩니다.</p><div class="phone"><main>${nav.replace('data-page="ai">', 'data-page="ai" class="active">')}${ai}</main></div></article>`,
    form('feeding', '8. 입력창 · 수유 기록', '‘수유 기록’·‘수유 추가’ 버튼을 누르면 열리는 입력창. 양은 텍스트로 ‘120ml’, ‘15분’처럼 입력합니다.'),
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
