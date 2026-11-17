// 隊伍編輯：六格隊伍＋與規則站隨機產生器相同的篩選面板、角色卡（圓點能力值、剩餘點數、隨機配點）、匯入匯出。
// 規則與畫面都在 pkcore.js（規則站 site/assets/pkcore.js 的複製品）；這裡負責把角色卡接到對戰引擎用的隊員格式。
export const SITE = 'https://bpmw0711.github.io/pokerole3.0-zh-TW/';
export const SPR = SITE + 'assets/spr/';
const ATTR_KEYS = ['str', 'dex', 'vit', 'spe', 'ins'];
const SOC_KEYS = ['tough', 'cool', 'beauty', 'clever', 'cute']; // 與規則站的社交能力值順序相同
const SK_KEYS = ['brawl', 'channel', 'clash', 'evasion', 'alert', 'athletic', 'nature', 'stealth', 'allure', 'etiquette', 'intimidate', 'perform'];
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

let P = null;
// 對戰資料（db.json）轉成 pkcore 要的形狀
function genData(DB) {
  return {
    dex: DB.dex.map((d) => ({
      ...d, leg: !!d.leg,
      ab: d.ab.map((n) => ({ n, z: DB.abilities[n.replace(/ \(Hidden\)/, '')]?.z || n })),
      mv: [...d.mv.map(([k, r]) => ({ k, n: k, z: DB.moves[k].z, t: DB.moves[k].t, r })), ...(d.any ? [{ n: 'Any Move', z: '任意招式', t: '', r: d.any, k: '' }] : [])],
    })),
    moves: DB.moves, abilities: DB.abilities, natures: DB.natures, chart: DB.chart, typeColor: DB.typeColor, typeInk: DB.typeInk,
    rankZh: DB.rankZh, statZh: DB.statZh, genZh: DB.genZh,
  };
}
export function core(DB) {
  if (!P) P = window.PKCORE.make(genData(DB), { img: SITE + 'assets/art/', rules: SITE + 'rules/', data: SITE + 'data/', blank: true });
  return P;
}

// 隊員（對戰引擎格式）⇄ 角色卡（產生器格式）
export function toSheet(m) {
  return {
    i: m.dex, rank: m.rank, style: 'species', nick: m.nick || '', item: m.item || '', note: m.note || '',
    hap: m.happiness ?? 2, loy: m.loyalty ?? 2, free: !!m.free, mode: 'rank',
    st: ATTR_KEYS.map((k) => m.attr[k] ?? 0), so: SOC_KEYS.map((k) => m.social[k] ?? 1), sk: SK_KEYS.map((k) => m.skills[k] || 0),
    mv: [...m.moves], ab: P.abName(m.ability || ''), na: m.nature || P.NA[0].n,
  };
}
export function toMon(s) {
  return {
    dex: s.i, nick: s.nick.trim(), rank: s.rank,
    attr: Object.fromEntries(ATTR_KEYS.map((k, i) => [k, s.st[i]])),
    social: Object.fromEntries(SOC_KEYS.map((k, i) => [k, s.so[i]])),
    skills: Object.fromEntries(SK_KEYS.map((k, i) => [k, s.sk[i]])),
    loyalty: s.loy, happiness: s.hap, ability: s.ab, item: s.item.trim(), moves: s.mv.slice(0, P.slots(s)).filter(Boolean),
    nature: s.na, note: s.note, free: s.free || undefined,
  };
}
export function monName(DB, m) { return m.nick || DB.dex[m.dex].z; }

// 建立編輯畫面。cb：{ toast, onSave(team), onBack() }；回傳 { el, mount }，el 放進頁面後要呼叫 mount()（篩選面板用 id 綁定）
export function buildEditor(DB, team, cb) {
  const P = core(DB), D = P.D;
  const sheets = team.mons.map(toSheet);
  let sel = sheets.length ? 0 : -1;
  const snap = () => JSON.stringify([nameIn.value, sheets.map(toMon)]);
  const nameOf = (s) => s.nick || D[s.i].z || D[s.i].n;

  const el = document.createElement('div');
  el.innerHTML = `<div class="edithead"><button type="button" class="b-back">← 返回</button><input class="tname" maxlength="30" aria-label="隊伍名稱" placeholder="隊伍名稱"><span class="sp"></span>
    <button type="button" class="b-team">匯入／匯出隊伍</button><button type="button" class="primary b-save">儲存隊伍</button></div>
   <div class="panel"><h2 class="ptitle">隊伍<small class="cnt"></small></h2><div class="party"></div></div>
   <div class="genwrap"><aside class="genl">${P.panelHTML('<button type="button" class="gbtn" id="ggo">加入隊伍</button><div class="row2"><button type="button" class="clear" id="gre">取代選取的這隻</button><button type="button" class="clear" id="gdup">複製選取的這隻</button></div><p class="note">條件與下方「寶可夢」選單決定要產生誰；點數依階級表隨機分配，之後可以在右邊角色卡用 ＋／− 或「重新隨機」調整。點數規則見<a href="' + SITE + 'rules/create-1.html" target="_blank" rel="noopener">階級表</a>。</p>')}</aside>
    <div id="gsheet"></div></div>`;
  const nameIn = el.querySelector('.tname');
  nameIn.value = team.name;
  const orig = snap();
  const party = el.querySelector('.party');

  function renderParty() {
    let h = '';
    for (let i = 0; i < 6; i++) {
      const s = sheets[i];
      if (!s) { h += `<div class="slot empty" data-add="1" tabindex="0" role="button"><b>＋</b><span>空位</span></div>`; continue; }
      const x = D[s.i];
      h += `<div class="slot${i === sel ? ' sel' : ''}" data-i="${i}" tabindex="0" role="button" aria-label="編輯 ${esc(nameOf(s))}">
        <button type="button" class="x" data-x="${i}" aria-label="移除" title="移除">×</button>
        <img class="sprite" src="${SPR}${x.img}.png" alt="" onerror="this.style.visibility='hidden'">
        <span class="sn">${esc(nameOf(s))}</span><span class="ss">${esc(P.RZ[s.rank])}・${s.mv.slice(0, P.slots(s)).filter(Boolean).length} 招</span>
        <span class="st">${x.ty.map((t) => `<span class="type" style="background:${P.TC[t] || '#888'}">${t}</span>`).join('')}</span></div>`;
    }
    party.innerHTML = h;
    el.querySelector('.cnt').textContent = `${sheets.length} / 6 隻`;
  }

  let v = null, pg = null;
  const box = () => el.querySelector('#gsheet');
  function refresh(scroll) {
    renderParty();
    if (sheets[sel]) { v.render(); if (scroll && window.matchMedia('(max-width:980px)').matches) box().scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else box().innerHTML = '<p class="note" style="padding:24px 8px;text-align:center">還沒有選取寶可夢。用左邊的條件按「加入隊伍」，或匯入隊伍。</p>';
  }
  function setSheets(list) { sheets.splice(0, sheets.length, ...list); sel = sheets.length ? Math.min(Math.max(sel, 0), sheets.length - 1) : -1; }

  function openMonIO() {
    const s = sheets[sel]; if (!s) return;
    P.dialog({
      title: '匯入／匯出這隻寶可夢', uploadTitle: nameOf(s), text: P.toPaste(s),
      hint: '文字是 <a href="https://pokepast.es/" target="_blank" rel="noopener">pokepast.es</a> 能顯示的格式：第一行的英文種名是給它找圖用的，其餘（特性、性格、招式、能力值等）都是中文，匯入時會全部讀回來。可貼上文字、pokepast.es 網址，或一般 Showdown 隊伍（缺的能力值會依階級隨機配點）。',
      imports: [
        { label: '取代選取的這隻', fn: (r) => { sheets[sel] = r.sets[0]; refresh(); return r.sets.length > 1 ? '已取代；內容有多隻，只用了第一隻。' : true; } },
        { label: '加入隊伍', fn: (r) => { const room = 6 - sheets.length; if (room <= 0) return '隊伍已滿 6 隻。'; sheets.push(...r.sets.slice(0, room)); sel = sheets.length - 1; refresh(); return r.sets.length > room ? `已加入 ${room} 隻（隊伍上限 6 隻）。` : true; } },
      ],
    });
  }
  function openTeamIO() {
    P.dialog({
      title: '匯入／匯出整個隊伍', uploadTitle: nameIn.value || '隊伍', text: P.toPasteTeam(sheets),
      hint: '一隻寶可夢一段，段與段之間空一行。可貼上文字、pokepast.es 網址（連隊伍名稱一起讀）或一般 Showdown 隊伍。每隊最多 6 隻。',
      imports: [
        { label: '取代整個隊伍', fn: (r) => { setSheets(r.sets.slice(0, 6)); sel = 0; if (r.title) nameIn.value = r.title; refresh(); return r.sets.length > 6 ? `已取代；內容有 ${r.sets.length} 隻，只用了前 6 隻。` : true; } },
        { label: '加入隊伍', fn: (r) => { const room = 6 - sheets.length; if (room <= 0) return '隊伍已滿 6 隻。'; sheets.push(...r.sets.slice(0, room)); sel = sheets.length - 1; refresh(); return r.sets.length > room ? `已加入 ${room} 隻（隊伍上限 6 隻）。` : true; } },
      ],
    });
  }

  function mount() {
    pg = P.panel();
    v = P.view(box(), {
      get: () => sheets[sel] || null,
      change: () => renderParty(),
      tools: [['io', '匯入／匯出這隻'], ['copy', '複製文字']],
      action: (a, s) => {
        if (a === 'io') openMonIO();
        else if (a === 'copy') P.copyText(P.asText(s), (ok) => v.msg(ok ? '已複製文字' : '無法複製，請手動選取'));
      },
    });
    el.querySelector('#ggo').addEventListener('click', () => {
      if (sheets.length >= 6) { cb.toast('隊伍最多 6 隻。要換掉其中一隻，請按「取代選取的這隻」。'); return; }
      const s = pg.make(); if (!s) { cb.toast('沒有符合條件的寶可夢'); return; }
      sheets.push(s); sel = sheets.length - 1; refresh(true);
    });
    el.querySelector('#gre').addEventListener('click', () => {
      if (!sheets[sel]) { cb.toast('先點選隊伍裡的一隻'); return; }
      const s = pg.make(); if (!s) { cb.toast('沒有符合條件的寶可夢'); return; }
      sheets[sel] = s; refresh(true);
    });
    el.querySelector('#gdup').addEventListener('click', () => {
      if (!sheets[sel]) { cb.toast('先點選隊伍裡的一隻'); return; }
      if (sheets.length >= 6) { cb.toast('隊伍最多 6 隻'); return; }
      sheets.push(JSON.parse(JSON.stringify(sheets[sel]))); sel = sheets.length - 1; refresh(true);
    });
    party.addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]');
      if (x) { e.stopPropagation(); const i = +x.dataset.x; sheets.splice(i, 1); if (sel >= sheets.length) sel = sheets.length - 1; refresh(); return; }
      const c = e.target.closest('.slot');
      if (!c) return;
      if (c.dataset.add) { document.getElementById('gq').focus(); return; }
      sel = +c.dataset.i; refresh(true);
    });
    party.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('slot')) { e.preventDefault(); e.target.click(); } });
    el.querySelector('.b-team').addEventListener('click', openTeamIO);
    el.querySelector('.b-back').addEventListener('click', () => { if (snap() !== orig && !confirm('放棄未儲存的變更？')) return; cb.onBack(); });
    el.querySelector('.b-save').addEventListener('click', () => {
      for (const s of sheets) if (!s.mv.slice(0, P.slots(s)).filter(Boolean).length) { cb.toast(`${nameOf(s)} 至少要有一個招式`); return; }
      team.name = nameIn.value.trim() || '未命名隊伍';
      team.mons = sheets.map(toMon);
      cb.onSave(team);
    });
    refresh();
  }
  return { el, mount };
}
