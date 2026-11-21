/* Optional features. Each lives in features/<id>.js and stays off until a deployment lists it in config.js:
     window.SOMHOUSE_FEATURES = {offline: 'all', meds: 'home'};
   'home' opens it to the family that runs this server, 'all' to every family.
   A feature behind a gate cannot reach other families, and a regulated one cannot run at all, until the deployment
   records that the gate was cleared (who decided what, and when):
     window.SOMHOUSE_GATES = {privacy: '2027-01-10 동의 화면과 처리방침 적용'};
   This guards against turning something on by mistake; it is not a security boundary.
   Loaded before app.js; start() runs at the end of app.js. */
(function (root) {
  'use strict';
  const BUILD = 'future-1';
  const GATES = {
    none: {label: '바로 가능', needs: '추가 조건 없음'},
    privacy: {label: '동의 필요', needs: '건강정보 별도 동의와 처리방침 갱신 뒤 다른 가족에게 공개'},
    regulated: {label: '규제 대기', needs: '식약처 등 소관 기관의 판단이나 허가를 받은 뒤에만 실행'},
  };
  const CATALOG = {
    offline: {title: '오프라인 기록', gate: 'none'},
    quicktext: {title: '키 없이 한 줄 기록', gate: 'none'},
    briefing: {title: '교대 브리핑·패턴 예측', gate: 'none'},
    shareai: {title: '내 AI 앱으로 보내기', gate: 'none'},
    ask: {title: '기록에 물어보기', gate: 'none'},
    privacy: {title: '개인정보 동의·내 데이터', gate: 'none'},
    meds: {title: '투약·체온 기록', gate: 'privacy'},
    growth: {title: '성장 기록', gate: 'privacy'},
    vaccines: {title: '예방접종·검진 일정', gate: 'privacy'},
  };
  const SEX = ['남', '여'];

  const objectOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const flags = () => objectOf(root.SOMHOUSE_FEATURES);
  const cleared = () => objectOf(root.SOMHOUSE_GATES);
  function audience(id, config = flags()) {
    const value = Object.hasOwn(config, id) ? config[id] : '';
    return value === 'home' || value === 'all' ? value : '';
  }
  function gatePassed(id, gates = cleared()) {
    const gate = CATALOG[id]?.gate;
    return gate === 'none' || (Object.hasOwn(gates, gate) && typeof gates[gate] === 'string' && gates[gate].trim() !== '');
  }
  // May the file be loaded at all? (Before login the family is not known yet.)
  function loadable(id, config = flags(), gates = cleared()) {
    if (!Object.hasOwn(CATALOG, id) || !audience(id, config)) return false;
    return CATALOG[id].gate !== 'regulated' || gatePassed(id, gates);
  }
  // Is it on for this family?
  function allowed(id, family, config = flags(), gates = cleared()) {
    if (!loadable(id, config, gates)) return false;
    if (family?.home === true) return true;
    return audience(id, config) === 'all' && gatePassed(id, gates);
  }

  const modules = new Map();
  let started = false;
  const family = () => (typeof shared !== 'undefined' && shared ? shared.family : null);
  const active = () => [...modules.values()].filter(m => allowed(m.id, family()));
  // A broken optional feature must never take the page down with it.
  function guarded(module, run, fallback) {
    try { return run(); } catch (error) { console.error(`솜하우스 기능 ${module.id} 오류`, error); return fallback; }
  }
  function refreshView() {
    if (typeof route !== 'function') return;
    if (typeof editingScreen === 'function' && editingScreen()) return;
    route();
  }
  function register(definition) {
    const id = definition?.id;
    if (!loadable(id) || modules.has(id)) return false;
    modules.set(id, definition);
    guarded(definition, () => definition.init?.(), undefined);
    refreshView();
    return true;
  }
  function start() {
    if (started) return;
    started = true;
    for (const id of Object.keys(CATALOG).filter(x => loadable(x))) {
      if (modules.has(id) || !document.head) continue;
      const script = document.createElement('script');
      script.src = `features/${id}.js?v=${BUILD}`;
      script.async = false;
      script.onerror = () => console.warn(`솜하우스 기능 파일을 찾지 못했어요: ${id}`);
      document.head.appendChild(script);
    }
  }
  const slot = name => active().map(m => guarded(m, () => m.slots?.[name]?.() || '', '')).join('');
  function page(name) {
    for (const m of active()) if (m.pages && Object.hasOwn(m.pages, name)) {
      const {title, view} = m.pages[name];
      return {title, view: () => guarded(m, view, '<div class="card empty">이 화면을 표시하지 못했어요.</div>')};
    }
    return null;
  }
  async function click(button) {
    for (const m of active()) {
      let handled = false;
      try { handled = await m.click?.(button); }
      catch (error) { console.error(`솜하우스 기능 ${m.id} 오류`, error); if (typeof message === 'function') message(error.message || '기능을 처리하지 못했어요.'); handled = true; }
      if (handled) return true;
    }
    return profileClick(button);
  }
  function reset() { for (const m of modules.values()) guarded(m, () => m.reset?.(), undefined); profileUi.open = false; }
  function style(id, css) {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.querySelector(`style[data-feature="${id}"]`)?.tagName) return;
    const element = document.createElement('style');
    element.dataset.feature = id;
    element.textContent = css;
    document.head.appendChild(element);
  }

  // Family-shared items of one feature, saved one at a time so two phones cannot overwrite each other.
  const items = id => {
    const list = objectOf(typeof shared !== 'undefined' && shared ? shared.settings?.features : null)[id];
    return Array.isArray(list) ? list : [];
  };
  const stamp = () => JSON.stringify(typeof shared !== 'undefined' && shared ? shared.settings?.features || null : null);
  async function change(feature, action, item) {
    if (typeof shared === 'undefined' || !shared?.token) return false;
    if (shared.readOnly) { alert(READ_ONLY); return false; }
    const token = shared.token;
    try {
      const result = await shared.request('/api/feature-data', 'POST', {feature, action, item});
      if (shared.token !== token) return false;
      if (result.settings) shared.settings = result.settings;
      return true;
    } catch (error) {
      if (shared.token !== token) return false;
      if (error.status === 401) showLogin(error.message);
      else { message(error.message); alert(error.message); }
      return false;
    }
  }
  const save = (feature, item) => change(feature, 'put', item);
  const remove = (feature, id) => change(feature, 'delete', {id});

  // The baby's birth date (and sex, for growth charts), shared by the features that need an age.
  const profileUi = {open: false};
  const validDay = v => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
    const time = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(time.getTime()) && time.toISOString().slice(0, 10) === v;
  };
  const profiles = () => items('profile').filter(x => x && typeof x.name === 'string' && x.name && validDay(x.birth));
  // Whole months and days of age on a date; null before birth.
  function ageOn(birth, day) {
    if (!validDay(birth) || !validDay(day) || day < birth) return null;
    const [by, bm, bd] = birth.split('-').map(Number), [y, m, d] = day.split('-').map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(by, bm - 1, bd)) / 86400000);
    let months = (y - by) * 12 + (m - bm);
    if (d < bd && d < new Date(Date.UTC(y, m, 0)).getUTCDate()) months--;
    return {days, months};
  }
  // The day a baby reaches an age in months; the 31st rolls back to the last day of a shorter month.
  function dayAtMonths(birth, months) {
    const [y, m, d] = birth.split('-').map(Number), last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
  }
  function profileCard(reason, withSex = false) {
    if (typeof shared !== 'undefined' && shared?.readOnly) return '';
    const list = profiles();
    if (!profileUi.open && list.length) {
      return `<p class="caption">👶 ${list.map(x => `${esc(x.name)} ${esc(x.birth)}${x.sex ? ` · ${esc(x.sex)}` : ''}`).join(', ')} <button type="button" class="plain small" data-fx-profile="open">아기 정보 고치기</button></p>`;
    }
    const first = list[0] || {}, names = typeof children === 'function' ? children() : [];
    const nameList = names.length ? `<datalist id="fx-names">${names.map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : '';
    return `<section class="card feature-form" aria-label="아기 정보"><h2>👶 아기 정보</h2><p class="caption">${esc(reason)} 가족끼리만 공유돼요.</p>`
      + `<label class="field">이름<input id="fx-name" maxlength="20" list="fx-names" value="${esc(first.name || names[0] || '')}" placeholder="예: 솜이">${nameList}</label>`
      + `<label class="field">태어난 날<input id="fx-birth" type="date" value="${esc(first.birth || '')}"></label>`
      + (withSex || first.sex ? `<label class="field">성별 (성장표준 비교에 필요해요)<select id="fx-sex"><option value="">고르지 않음</option>${SEX.map(x => `<option${first.sex === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>` : '')
      + `<div class="actions">${list.length ? '<button type="button" class="plain" data-fx-profile="close">취소</button>' : ''}<button type="button" data-fx-profile="save">저장</button></div></section>`;
  }
  async function profileClick(button) {
    const action = button.dataset?.fxProfile;
    if (!action) return false;
    if (action === 'open' || action === 'close') { profileUi.open = action === 'open'; render(); return true; }
    const name = String(document.querySelector('#fx-name')?.value || '').trim(), birth = String(document.querySelector('#fx-birth')?.value || '');
    const sex = String(document.querySelector('#fx-sex')?.value || ''), today = Somhouse.localDateTime().slice(0, 10), saved = profiles()[0];
    if (!name || name.length > 20 || !validDay(birth) || birth > today) { alert('이름과 태어난 날(오늘 이전)을 확인해 주세요.'); return true; }
    const item = {id: saved?.id || newId(), name, birth, ...(SEX.includes(sex) ? {sex} : saved?.sex && !document.querySelector('#fx-sex') ? {sex: saved.sex} : {})};
    if (await save('profile', item)) { profileUi.open = false; message('아기 정보를 저장했어요.'); render(); }
    return true;
  }

  const api = {BUILD, GATES, CATALOG, audience, gatePassed, loadable, allowed, register, start, slot, page, click, reset, style,
    items, stamp, save, remove, profiles, profileCard, ageOn, dayAtMonths, validDay};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SomhouseFeatures = api;
})(typeof window !== 'undefined' ? window : this);
