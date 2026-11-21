'use strict';
/* Use the AI subscription the family already pays for, with no API key and no approval from anyone: Somhouse writes a
   question with this week's numbers and hands it to the ChatGPT, Claude or Gemini app through the phone's share sheet.
   Only daily averages go in, never names, notes or single records, and the exact text is shown before it leaves. */
(function (root) {
  const TOPICS = {
    week: {label: '이번 주 요약', ask: '이번 주 수유·수면·기저귀 흐름을 세 줄로 요약하고, 지난주와 달라진 점을 숫자로 알려 주세요.'},
    sleep: {label: '수면', ask: '수면 숫자를 보고 달라진 점을 짚어 주고, 일반적으로 시도해 볼 만한 수면 습관 팁을 세 가지 알려 주세요.'},
    feeding: {label: '수유', ask: '수유 횟수와 양의 변화를 짚어 주고, 보호자가 다음 주에 눈여겨볼 점을 알려 주세요.'},
    visit: {label: '소아과 질문', ask: '다음 소아과 진료 때 의사에게 물어보면 좋을 질문을 3~5개 정리해 주세요.'},
  };
  const QUESTION_MAX = 300;
  const num = v => (v === null || v === undefined ? null : Number(v));
  function weekLine(name, w) {
    const parts = [`수유 ${w.feedings_per_day}회`];
    if (num(w.measured_ml_per_day) !== null) parts.push(`분유 ${w.measured_ml_per_day}ml`);
    if (num(w.breastfeeding_minutes_per_day) !== null) parts.push(`직수 ${w.breastfeeding_minutes_per_day}분`);
    parts.push(`수면 ${w.sleep_hours_per_day}시간`, `기저귀 ${w.diapers_per_day}회`, `대변 ${w.poo_per_day}회`);
    return `- ${name} (${w.from} ~ ${w.to}, 기록이 있는 날 ${w.days_with_records}일): 하루 평균 ${parts.join(', ')}`;
  }
  function buildText(topic, question, numbers) {
    const ask = String(question || '').trim().slice(0, QUESTION_MAX) || TOPICS[topic]?.ask || TOPICS.week.ask;
    return ['아기 육아 기록을 앱이 계산한 하루 평균 숫자예요. 7일로 나누었으니, 기록이 있는 날이 7일보다 적으면 실제보다 낮게 보일 수 있어요.',
      weekLine('최근 7일', numbers.this_week), weekLine('그 전 7일', numbers.last_week), '',
      `질문: ${ask}`, '', '숫자에 없는 내용은 추측하지 말고, 진단이나 처방은 하지 마세요. 걱정되는 변화가 있으면 소아과 상담을 권해 주세요.'].join('\n');
  }
  const api = {TOPICS, buildText};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SomhouseShareAI = api;

  const H = SomhouseFeatures, ui = {topic: 'week', question: '', status: ''};
  const APPS = [['ChatGPT', 'https://chatgpt.com/'], ['Claude', 'https://claude.ai/'], ['Gemini', 'https://gemini.google.com/']];
  const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const hasData = n => n.this_week.days_with_records > 0 || n.last_week.days_with_records > 0;
  const currentText = () => buildText(ui.topic, ui.question, aiWeekNumbers());
  function card() {
    if (shared?.readOnly) return '';
    const numbers = aiWeekNumbers();
    if (!hasData(numbers)) return '';
    const chips = Object.entries(TOPICS).map(([id, t]) => `<button type="button" class="${ui.topic === id && !ui.question ? '' : 'secondary '}small" data-share-topic="${id}" aria-pressed="${ui.topic === id && !ui.question}">${esc(t.label)}</button>`).join('');
    const links = APPS.map(([name, url]) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${name} 열기 ↗</a>`).join(' · ');
    return `<section class="card ai-help feature-form share-ai" aria-label="내 AI 앱에 물어보기"><h2>📤 내 AI 앱에 물어보기</h2><p class="caption">이미 쓰는 ChatGPT·Claude·Gemini 앱으로 보내요. API 키가 필요 없고, 쓰던 구독 그대로 답해요.</p><div class="quick">${chips}</div><label class="field">직접 질문 (선택)<textarea data-share-question="1" maxlength="${QUESTION_MAX}" placeholder="비워 두면 위에서 고른 주제로 물어봐요">${esc(ui.question)}</textarea></label><details><summary>보낼 내용 미리 보기</summary><pre class="share-preview" data-share-preview="1">${esc(currentText())}</pre></details><div class="actions"><button type="button" data-share-send="1">${canShare() ? '앱으로 보내기' : '복사하기'}</button></div>${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}<p class="caption">하루 평균 숫자와 질문만 보내요. 이름·메모·개별 기록은 들어가지 않아요. 보낸 뒤의 내용은 그 AI 앱의 약관을 따라요. ${links}</p></section>`;
  }
  async function send() {
    const text = currentText();
    try {
      if (canShare()) { await navigator.share({text}); ui.status = '앱으로 보냈어요. 답변은 그 앱에서 볼 수 있어요.'; }
      else { await navigator.clipboard.writeText(text); ui.status = '복사했어요. AI 앱을 열고 붙여 넣어 주세요.'; }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      ui.status = '보내지 못했어요. 미리 보기의 글을 길게 눌러 복사해 주세요.';
    }
    render();
  }
  if (typeof document.addEventListener === 'function') document.addEventListener('input', event => {
    if (!event.target?.dataset?.shareQuestion) return;
    ui.question = String(event.target.value || '').slice(0, QUESTION_MAX);
    const preview = document.querySelector('[data-share-preview]');
    if (preview) preview.textContent = currentText();
  });
  H.register({
    id: 'shareai',
    init() { H.style('shareai', '.share-preview{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#f3f3ec;border-radius:10px;padding:10px;margin:6px 0 0;font-family:inherit}'); },
    slots: {stats: card},
    reset() { Object.assign(ui, {topic: 'week', question: '', status: ''}); },
    async click(button) {
      const d = button.dataset || {};
      if (d.shareTopic && TOPICS[d.shareTopic]) { ui.topic = d.shareTopic; ui.question = ''; ui.status = ''; render(); return true; }
      if (d.shareSend) { await send(); return true; }
      return false;
    },
  });
})(typeof window !== 'undefined' ? window : this);
