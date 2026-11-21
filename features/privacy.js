'use strict';
/* What a public release needs before other families' baby records are handled: a separate consent for health-related
   records from a guardian, a separate choice about sending questions to overseas AI companies, a way to take the data
   out, and a way to withdraw. Turning this on stops other families' writes and AI requests until they consent.
   The family that runs the server is not asked. The wording is a draft for legal review (docs/PRIVACY_POLICY_DRAFT.md). */
(function (root) {
  const VERSION = '2026-11-draft-1';
  // Requests that record something about the baby. Signing in, managing the family and consent itself stay open.
  const WRITES = [/^\/api\/items\//, /^\/api\/timer$/, /^\/api\/handoff$/, /^\/api\/review$/, /^\/api\/confirm$/, /^\/api\/merge$/, /^\/api\/stock$/];
  const AI_PATHS = [/^\/api\/ai$/, /^\/api\/chatgpt\/ask$/];
  function requirement(path, method, body) {
    if (method === 'GET' || method === 'OPTIONS') return '';
    if (AI_PATHS.some(x => x.test(path))) return 'ai';
    if (path === '/api/feature-data') return body?.feature === 'privacy' ? '' : 'health';
    return WRITES.some(x => x.test(path)) ? 'health' : '';
  }
  // A spreadsheet must not run a cell as a formula.
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  const COLUMNS = ['type', 'date', 'end', 'category', 'amount', 'hospital', 'reason', 'memo', 'id'];
  function recordsCsv(records) {
    const rows = [...records].sort((a, b) => String(a.date).localeCompare(String(b.date))).map(x => COLUMNS.map(k => csvCell(x[k])).join(','));
    return '﻿' + [COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
  }
  function exportJson(data, settings, at) {
    const {children = [], handoff = null, stock = [], features = {}} = settings || {};
    return JSON.stringify({exportedAt: at, app: 'somhouse', records: data.records, schedule: data.schedule, shopping: data.shopping, settings: {children, handoff, stock}, features}, null, 1);
  }
  const api = {VERSION, requirement, csvCell, recordsCsv, exportJson};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const H = SomhouseFeatures, ui = {status: ''};
  const consentId = () => `consent:${shared?.username || ''}`;
  const mine = () => H.items('privacy').find(x => x.id === consentId() && x.version === VERSION) || null;
  const asked = () => Boolean(shared?.token) && !shared.readOnly && H.allowed('privacy', shared.family) && shared.family?.home !== true;
  const has = kind => !asked() || mine()?.[kind] === true;
  root.SomhouseConsent = {has, asked};
  const refusal = kind => {
    const error = Error(kind === 'ai' ? 'AI로 보내려면 ‘내 데이터·동의’에서 AI 전송에 동의해 주세요.' : '기록하려면 먼저 건강 관련 기록 처리에 동의해 주세요. 홈 화면에서 동의할 수 있어요.');
    error.status = 403;
    return error;
  };
  const NOTICE = `<dl class="consent-terms"><dt>처리 목적</dt><dd>가족이 아기의 돌봄 기록을 함께 남기고 보기 위해서만 써요.</dd><dt>항목</dt><dd>수유·수면·기저귀·병원 방문과 이유, 투약·체온·성장 등 입력한 기록, 아기 이름·생년월일·성별</dd><dt>보관 기간</dt><dd>동의를 철회하거나 삭제를 요청할 때까지 보관해요. 백업에서는 보관 기간이 지나면 사라져요.</dd><dt>거부할 권리</dt><dd>동의하지 않을 수 있어요. 다만 동의 전에는 새 기록을 저장할 수 없어요.</dd></dl>`;
  function consentCard() {
    return `<section class="card feature-form consent-card" aria-label="개인정보 동의"><h2>🔐 기록을 시작하기 전에</h2><p class="caption">아기의 수유·병원 같은 기록은 법에서 따로 보호하는 건강 관련 정보예요. 아래 내용을 읽고 각각 선택해 주세요.</p>${NOTICE}<label class="consent-check"><input type="checkbox" id="consent-guardian"> <span><b>(필수)</b> 저는 이 아기의 보호자(법정대리인)예요.</span></label><label class="consent-check"><input type="checkbox" id="consent-health"> <span><b>(필수)</b> 건강 관련 기록을 위 내용대로 처리하는 데 동의해요.</span></label><label class="consent-check"><input type="checkbox" id="consent-ai"> <span><b>(선택)</b> AI 기능을 쓸 때 질문과 고른 집계를 내가 고른 AI 회사(OpenAI·Anthropic·Google, 미국 등 국외)로 보내는 데 동의해요.</span></label><div class="actions"><button type="button" data-consent="save">동의하고 시작하기</button></div>${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}<p class="caption"><a href="privacy.html" target="_blank" rel="noopener">개인정보처리방침 전문</a></p></section>`;
  }
  function homeSlot() {
    if (asked() && !mine()) return consentCard();
    return '';
  }
  const entryLink = () => (shared?.readOnly ? '' : `<p class="caption privacy-link"><button type="button" class="plain small" data-page="mydata">🔐 내 데이터·동의 관리</button></p>`);
  function row(label, on) { return `<li>${esc(label)} <span class="badge${on ? '' : ' off'}">${on ? '동의함' : '동의 안 함'}</span></li>`; }
  function page() {
    const c = mine(), isAsked = asked();
    const consent = isAsked ? `<section class="card"><h2>내 동의</h2>${c ? `<ul class="report-list">${row('건강 관련 기록 처리', c.health)}${row('AI 회사로 전송 (국외)', c.ai)}</ul><p class="caption">${esc(String(c.at).replace('T', ' '))}에 동의했어요 (${esc(VERSION)}).</p><div class="actions"><button type="button" class="secondary" data-consent="${c.ai ? 'ai-off' : 'ai-on'}">AI 전송 ${c.ai ? '철회' : '동의'}</button><button type="button" class="danger" data-consent="withdraw">전체 동의 철회</button></div><p class="caption">철회하면 새 기록과 AI 사용이 멈춰요. 저장된 기록을 지우려면 아래 삭제 요청을 해 주세요.</p>` : '<p>아직 동의하지 않았어요. 홈 화면에서 동의할 수 있어요.</p>'}</section>` : '';
    return `<h1>내 데이터·동의</h1>${consent}<section class="card"><h2>내 데이터 내려받기</h2><p class="caption">우리 가족의 기록을 이 기기로 내려받아요. 파일에는 건강 관련 정보가 들어 있으니 보관에 주의해 주세요.</p><div class="actions"><button type="button" class="secondary" data-export="csv">표 파일(CSV)</button><button type="button" data-export="json">전체(JSON)</button></div>${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}</section><section class="card"><h2>기록이 저장되고 전달되는 곳</h2><ul class="report-list"><li>솜하우스 서버: 가족별로 나누어 저장해요.</li><li>Google(연결한 경우): 그 가족의 시트·Tasks·캘린더에 사본이 남아요.</li><li>AI 회사(직접 고른 경우에만): 질문과 고른 집계가 OpenAI·Anthropic·Google로 전송돼요.</li></ul></section><section class="card"><h2>삭제 요청</h2><p class="caption">가족 전체 기록 삭제는 Google 로그인 화면에 표시되는 개발자 지원 이메일로 요청해 주세요. 공개 게시판에는 아기 정보를 적지 마세요.</p></section><button class="plain" data-page="home">← 홈으로</button>`;
  }
  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], {type})), link = document.createElement('a');
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function saveConsent() {
    const guardian = document.querySelector('#consent-guardian')?.checked, health = document.querySelector('#consent-health')?.checked, aiOn = document.querySelector('#consent-ai')?.checked === true;
    if (!guardian || !health) { ui.status = '필수 항목 두 개에 체크해 주세요.'; render(); return; }
    if (await H.save('privacy', {id: consentId(), user: shared.username, version: VERSION, guardian: true, health: true, ai: aiOn, at: Somhouse.localDateTime()})) {
      ui.status = ''; message('동의를 저장했어요. 이제 기록할 수 있어요.'); render();
    }
  }
  H.register({
    id: 'privacy',
    init() {
      H.style('privacy', '.consent-terms{margin:8px 0;font-size:14px}.consent-terms dt{font-weight:700;margin-top:6px}.consent-terms dd{margin:0;color:#536158}.consent-check{display:flex;gap:8px;align-items:flex-start;padding:8px 0;font-size:15px}.consent-check input{width:20px;height:20px;flex:none;margin-top:2px}.privacy-link{margin:0 0 8px}');
      if (!shared) return;
      const attempt = shared.attempt.bind(shared);
      shared.attempt = (path, method, body, ...rest) => {
        const needs = requirement(path, method, body);
        return needs && !has(needs) ? Promise.reject(refusal(needs)) : attempt(path, method, body, ...rest);
      };
      if (typeof aiDirect !== 'undefined' && aiDirect?.ask) {
        const ask = aiDirect.ask;
        aiDirect.ask = (...args) => (has('ai') ? ask(...args) : Promise.reject(refusal('ai')));
      }
    },
    slots: {alert: homeSlot, records: entryLink},
    pages: {mydata: {title: '내 데이터·동의', view: page}},
    reset() { ui.status = ''; },
    async click(button) {
      const d = button.dataset || {};
      if (d.export) {
        const day = Somhouse.localDateTime().slice(0, 10);
        if (d.export === 'csv') download(`somhouse-records-${day}.csv`, 'text/csv;charset=utf-8', recordsCsv(data.records));
        else download(`somhouse-${day}.json`, 'application/json', exportJson(data, shared.settings, Somhouse.localDateTime()));
        ui.status = '내려받았어요.'; render();
        return true;
      }
      if (!d.consent) return false;
      if (d.consent === 'save') { await saveConsent(); return true; }
      const c = mine();
      if (!c) return true;
      if (d.consent === 'withdraw') {
        if (confirm('동의를 철회할까요? 새 기록 저장과 AI 사용이 멈춰요.') && await H.remove('privacy', c.id)) { message('동의를 철회했어요.'); location.hash = 'home'; render(); }
        return true;
      }
      if (await H.save('privacy', {...c, ai: d.consent === 'ai-on', at: Somhouse.localDateTime()})) { message(d.consent === 'ai-on' ? 'AI 전송에 동의했어요.' : 'AI 전송 동의를 철회했어요.'); render(); }
      return true;
    },
  });
})(typeof window !== 'undefined' ? window : this);
