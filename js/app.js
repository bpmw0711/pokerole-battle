import * as E from './engine.js';
import * as Net from './net.js';
import { moveInfo, EVASION, CLASH, STRUGGLE } from './moves.js';
import { buildEditor, core, toMon, toSheet, monName, SPR } from './editor.js';

const ATTRS = [['str', '力量'], ['dex', '靈巧'], ['vit', '體魄'], ['spe', '特殊'], ['ins', '洞察']];
const SOC = [['tough', '強壯'], ['cool', '帥氣'], ['beauty', '美麗'], ['cute', '可愛'], ['clever', '聰明']];
const SKILLS = [['戰鬥', [['brawl', '鬥毆'], ['channel', '導引'], ['clash', '對抗'], ['evasion', '閃避']]],
  ['生存', [['alert', '警覺'], ['athletic', '運動'], ['nature', '自然'], ['stealth', '隱匿']]],
  ['社交', [['allure', '魅惑'], ['etiquette', '禮儀'], ['intimidate', '威嚇'], ['perform', '表演']]]];
const CAT = { phys: '物理', spec: '特殊', status: '變化' };

let DB;
const APP = { view: 'home', editing: null, post: null, room: null, mods: { acc: 0, dmg: 0, push: false, count: 1 }, page: 0, modal: null };

// ───────── 小工具 ─────────
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無痕模式 */ } };
const typeChip = (t) => t ? h('span', { class: 'type', style: { background: DB.typeColor[t] || '#888' } }, t) : null;
const sprite = (dex, cls) => h('img', { class: cls, src: SPR + DB.dex[dex].img + '.png', alt: DB.dex[dex].z, onerror: (e) => { e.target.style.visibility = 'hidden'; } });
const rankName = (r) => DB.rankZh[r] || r;
const uidShort = () => Math.random().toString(36).slice(2, 8);

// ───────── 啟動 ─────────
async function boot() {
  DB = await (await fetch('data/db.json')).json();
  E.setDB(DB);
  const guest = new URLSearchParams(location.search).has('guest');
  try { await Net.init({ guest }); } catch (e) { render(); toast('連線失敗：' + e.message); return; }
  const code = new URLSearchParams(location.search).get('room');
  if (code) await enterRoom(code, false);
  else render();
}

function render() {
  const app = document.getElementById('app');
  app.replaceChildren();
  const v = { home: viewHome, teams: viewTeams, edit: viewEdit, room: viewRoom }[APP.view];
  APP.post = null;
  if (APP.lastView !== APP.view) { window.scrollTo(0, 0); APP.lastView = APP.view; }
  app.append(v());
  if (APP.modal) app.append(APP.modal());
  if (APP.post) { const f = APP.post; APP.post = null; f(); } // 元素放進頁面之後才能做的事（綁定篩選面板、讀取房間）
}

// ───────── 首頁 ─────────
const hero = (title, sub) => h('div', { class: 'hero' }, h('span', { class: 'pball' }), h('div', {}, h('h1', {}, title), sub ? h('small', {}, sub) : null));
const ptitle = (t, small) => h('h2', { class: 'ptitle' }, t, small ? h('small', {}, small) : null);

// 最近進出的房間（存在這個瀏覽器；伺服器上的房間不會因此被刪除）
const isGuest = () => new URLSearchParams(location.search).has('guest');
const recents = () => load('pkb.rooms', []).filter((r) => Date.now() - r.ts < 14 * 86400e3);
function touchRoom(code, patch) {
  if (isGuest()) return;
  const old = recents().find((r) => r.code === code) || { code };
  const list = recents().filter((r) => r.code !== code);
  list.unshift({ ...old, ...patch, ts: Date.now() });
  save('pkb.rooms', list.slice(0, 12));
}
const forgetRoom = (code) => save('pkb.rooms', recents().filter((r) => r.code !== code));

function roomStatus(snap, side) {
  if (snap.ver !== E.ENGINE_VER) return { kind: 'end', text: '版本不同，無法重連', dead: true };
  let s;
  try { s = E.replay(snap.settings, snap.events); } catch { return { kind: 'end', text: '紀錄無法重播', dead: true }; }
  const foe = E.other(side);
  if (s.winner) return { kind: 'end', text: s.winner === 'draw' ? '平手' : s.winner === side ? '已結束：你贏了' : '已結束：對手獲勝' };
  if (s.phase === 'setup') {
    if (!snap.players[foe]) return { kind: 'wait', text: '等待對手加入' };
    return s.sides[side].team ? { kind: 'wait', text: '等待對手選隊伍' } : { kind: 'go', text: '輪到你選隊伍' };
  }
  const ex = E.expecting(s);
  return ex.sides.includes(side) ? { kind: 'go', text: `輪到你了（第 ${s.round} 戰鬥輪）` } : { kind: 'wait', text: `等待對手（第 ${s.round} 戰鬥輪）` };
}

async function refreshRooms() {
  const box = document.getElementById('myrooms');
  const list = recents();
  if (!box || !list.length) return;
  box.replaceChildren(h('div', { class: 'panel' }, ptitle('我的房間'), h('p', { class: 'muted small' }, '讀取中…')));
  const rows = [];
  await Promise.all(list.map(async (r) => {
    try {
      const snap = await Net.roomSnapshot(r.code);
      if (!snap) { forgetRoom(r.code); return; }
      const side = snap.players.A?.uid === Net.uid ? 'A' : snap.players.B?.uid === Net.uid ? 'B' : null;
      if (!side) { forgetRoom(r.code); return; }
      rows.push({ r, foe: snap.players[E.other(side)]?.name || '', st: roomStatus(snap, side) });
    } catch { rows.push({ r, foe: r.opp || '', st: { kind: 'wait', text: '暫時讀不到' } }); }
  }));
  if (!document.getElementById('myrooms')) return; // 已經換頁
  const order = { go: 0, wait: 1, end: 2 };
  rows.sort((a, b) => order[a.st.kind] - order[b.st.kind] || b.r.ts - a.r.ts);
  box.replaceChildren(rows.length ? h('div', { class: 'panel' }, ptitle('我的房間', '斷線或重開後，點「重新連線」就能回到原本的位置'),
    rows.map(({ r, foe, st }) => h('div', { class: `roomrow ${st.kind === 'go' ? 'mine' : ''}` },
      h('span', { class: 'rc' }, r.code),
      h('span', {}, foe ? `對手：${foe}` : '對手：—'),
      h('span', { class: `pill ${st.kind}` }, st.text),
      h('span', { class: 'grow' }),
      st.dead ? null : h('button', { class: st.kind === 'go' ? 'primary' : '', onclick: () => enterRoom(r.code, true) }, st.kind === 'end' ? '查看' : '重新連線'),
      h('button', { class: 'small', title: '只從這個清單移除，房間本身不會被刪除', onclick: () => { forgetRoom(r.code); refreshRooms(); } }, '移除')))) : '');
}

function viewHome() {
  const name = load('pkb.name', '');
  const st = load('pkb.settings', { teamSize: 3, defMode: 1, hpStat: 'vit' });
  const nameIn = h('input', { value: name, placeholder: '你的名字', maxlength: 20, oninput: (e) => save('pkb.name', e.target.value.trim()) });
  const codeIn = h('input', { placeholder: '6 碼房號', maxlength: 6, style: { width: '120px', textTransform: 'uppercase', letterSpacing: '3px', fontWeight: 700 } });
  const size = h('select', { onchange: (e) => { st.teamSize = +e.target.value; save('pkb.settings', st); } }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n, selected: st.teamSize === n }, `每方 ${n} 隻`)));
  const defm = h('select', { onchange: (e) => { st.defMode = +e.target.value; save('pkb.settings', st); render(); } },
    h('option', { value: 1, selected: st.defMode === 1 }, '雙防選項 1：防禦＝特防＝體魄'),
    h('option', { value: 2, selected: st.defMode === 2 }, '雙防選項 2：防禦＝體魄、特防＝洞察'));
  const hp = st.defMode === 2 ? h('select', { onchange: (e) => { st.hpStat = e.target.value; save('pkb.settings', st); } },
    h('option', { value: 'vit', selected: st.hpStat !== 'ins' }, 'HP 用體魄計算'), h('option', { value: 'ins', selected: st.hpStat === 'ins' }, 'HP 用洞察計算')) : null;
  const teams = load('pkb.teams', []);
  APP.post = refreshRooms;
  return h('div', {},
    hero('Pokérole 3.0 線上對戰', '朋友之間的單打對戰　自動擲骰、判定行動順序、計算傷害'),
    h('div', { class: 'panel' }, ptitle('訓練家'), h('div', { class: 'row' }, h('label', { class: 'field-l' }, '名字'), nameIn)),
    h('div', { id: 'myrooms' }),
    h('div', { class: 'menu' },
      h('div', { class: 'panel' }, ptitle('開新房間'), h('div', { class: 'stack' }, size, defm, hp, h('button', { class: 'primary', onclick: () => createRoom(st) }, '建立房間'))),
      h('div', { class: 'panel' }, ptitle('加入房間'), h('div', { class: 'stack' }, h('p', { class: 'muted small', style: { margin: 0 } }, '輸入對手給你的房號，或直接開啟他傳的邀請連結。'),
        h('div', { class: 'row' }, codeIn, h('button', { class: 'primary', onclick: () => enterRoom(codeIn.value, true) }, '加入')))),
      h('div', { class: 'panel' }, ptitle('我的隊伍', `${teams.length} 隊`), h('div', { class: 'stack' },
        teams.length ? h('div', { class: 'muted small' }, teams.slice(0, 3).map((t) => h('div', {}, `${t.name}（${t.mons.length} 隻）`))) : h('p', { class: 'muted small', style: { margin: 0 } }, '還沒有隊伍，先去建一隊吧。'),
        h('button', { onclick: () => { APP.view = 'teams'; render(); } }, '管理隊伍')))),
    h('p', { class: 'small muted' }, '規則依 Pokerole 3.0 原書；本工具的判定方式與改編見 ', h('a', { href: 'RULES-NOTES.md', target: '_blank' }, '規則判定紀錄'), '。'),
  );
}
function myName() {
  const n = load('pkb.name', '');
  if (!n) { toast('請先輸入名字'); return null; }
  return n;
}
async function createRoom(settings) {
  const name = myName(); if (!name) return;
  try {
    const code = await Net.createRoom(settings, name, E.ENGINE_VER);
    await enterRoom(code, false);
  } catch (e) { toast(e.message); }
}

// ───────── 隊伍管理 ─────────
function viewTeams() {
  const teams = load('pkb.teams', []);
  const P = core(DB);
  const newTeam = () => { APP.editing = { id: uidShort(), name: '新隊伍', mons: [] }; APP.view = 'edit'; render(); };
  const importTeam = () => P.dialog({
    title: '匯入隊伍', text: '', hint: '貼上 <a href="https://pokepast.es/" target="_blank" rel="noopener">pokepast.es</a> 網址、Pokémon Showdown 格式的文字，或本工具、規則站隨機產生器匯出的文字。每隊最多 6 隻。',
    imports: [{ label: '匯入為新隊伍', fn: (r) => {
      const t = { id: uidShort(), name: r.title || '匯入的隊伍', mons: r.sets.slice(0, 6).map(toMon) };
      teams.push(t); save('pkb.teams', teams); render();
      return true;
    } }],
  });
  const exportTeam = (t) => P.dialog({
    title: `匯出隊伍：${t.name}`, uploadTitle: t.name, text: P.toPasteTeam(t.mons.map(toSheet)), imports: [],
    hint: '複製這段文字，或上傳到 <a href="https://pokepast.es/" target="_blank" rel="noopener">pokepast.es</a> 取得分享網址。第一行、特性、性格、招式用英文，Pokerole 專有的能力值等放在另外幾行。',
  });
  return h('div', {},
    hero('我的隊伍', '隊伍存在這台裝置的瀏覽器裡，可用匯出備份或分享'),
    h('div', { class: 'row', style: { marginBottom: '12px' } }, h('button', { onclick: () => { APP.view = 'home'; render(); } }, '← 回首頁'),
      h('button', { class: 'primary', onclick: newTeam }, '＋ 新增隊伍'), h('button', { onclick: importTeam }, '匯入隊伍')),
    h('div', { class: 'panel' }, ptitle('隊伍清單', `${teams.length} 隊`),
      teams.length ? teams.map((t, i) => h('div', { class: 'teamcard' },
        h('div', { class: 'minis' }, [0, 1, 2, 3, 4, 5].map((k) => t.mons[k] ? sprite(t.mons[k].dex) : h('span', { class: 'e' }, '·'))),
        h('div', { class: 'grow' }, h('b', {}, t.name), h('div', { class: 'small muted' }, `${t.mons.length} 隻：${t.mons.map((m) => monName(DB, m)).join('、') || '（空）'}`)),
        h('button', { class: 'small', onclick: () => { APP.editing = structuredClone(t); APP.view = 'edit'; render(); } }, '編輯'),
        h('button', { class: 'small', onclick: () => exportTeam(t) }, '匯出'),
        h('button', { class: 'small', onclick: () => { const c = structuredClone(t); c.id = uidShort(); c.name += '（複製）'; teams.splice(i + 1, 0, c); save('pkb.teams', teams); render(); } }, '複製'),
        h('button', { class: 'small', onclick: () => { if (confirm(`刪除隊伍「${t.name}」？`)) { teams.splice(i, 1); save('pkb.teams', teams); render(); } } }, '刪除')))
        : h('p', { class: 'muted' }, '還沒有隊伍。按「新增隊伍」，或匯入別人分享的隊伍。')));
}

function viewEdit() {
  const ed = buildEditor(DB, APP.editing, {
    toast,
    onBack: () => { APP.view = 'teams'; render(); },
    onSave: (team) => {
      const teams = load('pkb.teams', []);
      const i = teams.findIndex((x) => x.id === team.id);
      if (i >= 0) teams[i] = team; else teams.push(team);
      save('pkb.teams', teams); toast('已儲存');
      APP.view = 'teams'; render();
    },
  });
  APP.post = ed.mount;
  return h('div', {}, ed.el);
}

// ───────── 房間 ─────────
async function enterRoom(code, joining) {
  code = String(code || '').trim().toUpperCase();
  if (!code) { toast('請輸入房號'); return; }
  const name = load('pkb.name', '') || '玩家';
  try {
    const info = await Net.roomInfo(code);
    if (!info) throw new Error('找不到這個房間');
    if (info.ver !== E.ENGINE_VER) toast('注意：這個房間是用不同版本的工具建立的，可能無法正常進行');
    let side = null;
    try { side = await Net.joinRoom(code, name); } catch (e) {
      if (!/滿/.test(e.message)) throw e;
      toast('房間已滿，以觀戰模式進入');
    }
    if (side) touchRoom(code, { side });
    if (APP.room && APP.room.unsub) APP.room.unsub();
    const room = { code, side, settings: info.settings, players: info.players, events: [], state: E.newGame(info.settings), broken: null };
    APP.room = room; APP.view = 'room'; APP.modal = null;
    history.replaceState(null, '', `?room=${code}${location.search.includes('guest') ? '&guest' : ''}`);
    room.unsub = Net.watch(code, {
      onPlayers: (p) => { room.players = p; const f = p[side === 'A' ? 'B' : 'A']; if (side && f) touchRoom(code, { opp: f.name }); render(); },
      onEvent: (key, ev) => {
        if (room.broken) return;
        const n = parseInt(key.slice(1), 10);
        if (n !== room.events.length) { room.broken = `事件順序錯誤（${n} / ${room.events.length}）`; render(); return; }
        try { room.state = E.applyEvent(room.state, ev); room.events.push(ev); } catch (e) { room.broken = '紀錄無法重播：' + e.message; }
        scheduleRender();
      },
    });
    render();
  } catch (e) { toast(e.message); if (joining === false) { APP.view = 'home'; render(); } }
}
let rTimer = null;
function scheduleRender() { clearTimeout(rTimer); rTimer = setTimeout(render, 30); }

async function send(intent) {
  const r = APP.room;
  if (!r.side) { toast('觀戰中不能操作'); return false; }
  let res;
  try { res = E.act(r.state, { side: r.side, ...intent }); } catch (e) { toast(e.message); return false; }
  try {
    const ok = await Net.pushEvent(r.code, r.events.length, res.event);
    if (!ok) { toast('對手剛好也送出了動作，畫面已更新，請再操作一次'); return false; }
    return true;
  } catch (e) { toast('送出失敗：' + e.message); return false; }
}

function viewRoom() {
  const r = APP.room, s = r.state;
  if (r.broken) return h('div', { class: 'panel' }, h('h2', {}, '對戰紀錄出了問題'), h('p', {}, r.broken), h('button', { onclick: () => location.reload() }, '重新載入'));
  if (s.phase === 'setup') return viewLobby();
  return viewBattle();
}

function viewLobby() {
  const r = APP.room, s = r.state;
  const teams = load('pkb.teams', []);
  if (!r.side) return h('div', {}, h('div', { class: 'row' }, h('button', { onclick: leave }, '← 離開'), h('h1', {}, `觀戰：房間 ${r.code}`)),
    h('p', { class: 'panel' }, '雙方還在準備隊伍…'));
  const mine = s.sides[r.side].team;
  const pick = h('select', {}, teams.map((t, i) => h('option', { value: i }, `${t.name}（${t.mons.length} 隻）`)));
  const url = `${location.origin}${location.pathname}?room=${r.code}`;
  return h('div', {},
    hero('對戰房間', `房號 ${r.code}`), h('div', { class: 'row', style: { marginBottom: '10px' } }, h('button', { onclick: leave }, '← 離開')),
    h('div', { class: 'panel' }, h('div', { class: 'row' }, h('span', {}, '房號'), h('span', { class: 'code' }, r.code),
      h('button', { class: 'small', onclick: () => navigator.clipboard.writeText(url).then(() => toast('已複製邀請連結')) }, '複製邀請連結')),
      h('p', { class: 'small muted' }, `每方最多 ${r.settings.teamSize} 隻・雙防選項 ${r.settings.defMode}${r.settings.defMode === 2 ? `・HP 用${r.settings.hpStat === 'ins' ? '洞察' : '體魄'}` : ''}`)),
    h('div', { class: 'panel' }, h('h2', { class: 'ptitle' }, '玩家'),
      ['A', 'B'].map((x) => h('div', {}, `${x === 'A' ? '房主' : '挑戰者'}：`, r.players[x]?.name || h('span', { class: 'muted' }, '等待加入…'),
        x === r.side ? h('span', { class: 'muted' }, '（你）') : null, s.sides[x].team ? h('span', { class: 'chip up' }, '隊伍已就緒') : null))),
    h('div', { class: 'panel' }, h('h2', { class: 'ptitle' }, '選擇出戰隊伍'),
      mine ? h('p', {}, '你的隊伍已送出，等待對手…')
        : teams.length ? h('div', { class: 'row' }, pick, h('button', { class: 'primary', onclick: () => {
          const t = teams[+pick.value];
          if (t.mons.length > r.settings.teamSize) { toast(`這個房間每方最多 ${r.settings.teamSize} 隻，請先調整隊伍`); return; }
          send({ type: 'team', team: t.mons, name: load('pkb.name', '') || r.players[r.side]?.name });
        } }, '送出隊伍'))
          : h('div', {}, h('p', {}, '你還沒有隊伍。'), h('button', { onclick: () => { APP.view = 'teams'; render(); } }, '去建立隊伍'))),
  );
}
function leave() {
  if (APP.room && APP.room.unsub) APP.room.unsub();
  APP.room = null; APP.view = 'home'; APP.modal = null;
  history.replaceState(null, '', location.pathname + (location.search.includes('guest') ? '?guest' : ''));
  render();
}

// ───────── 對戰畫面 ─────────
function bannerText(s, me, spect) {
  const ex = E.expecting(s);
  const mine = !spect && ex.sides.includes(me);
  if (spect && !s.winner) return [`觀戰中：等待 ${ex.sides.map((x) => s.sides[x].name || x).join('、')}`, false];
  const foeName = s.sides[E.other(me)].name || '對手';
  if (s.winner) return [s.winner === 'draw' ? '平手！' : s.winner === me ? '你贏了！' : `${foeName} 獲勝`, true];
  const t = {
    lead: ['選擇首發寶可夢', '等待對手選首發'],
    turn: ['輪到你了', `輪到 ${foeName}`],
    react: ['對手的攻擊命中了！要反應嗎？', '等待對手決定是否反應'],
    faintSwap: ['選擇下一隻寶可夢', '等待對手派出下一隻'],
    switcherSwap: ['選擇要換上的寶可夢', '等待對手換寶可夢'],
    endSwap: ['戰鬥輪結束：要換寶可夢嗎？', '等待對手決定是否換人'],
    ice: ['冰凍中：要用招式打冰塊嗎？', '等待對手處理冰塊'],
  }[ex.phase] || ['', ''];
  if (!mine && (ex.phase === 'endSwap' || ex.phase === 'lead') && s.await[me] && s.picks[me] !== undefined) return ['已選擇，等待對手', false];
  return [mine ? t[0] : t[1], mine];
}

function monPanel(s, sd, me) {
  const mon = E.active(s, sd);
  const side = s.sides[sd];
  if (!mon) return h('div', {});
  const pct = mon.hp / mon.maxHp;
  const color = pct > 0.5 ? 'var(--hp-hi)' : pct > 0.2 ? 'var(--hp-mid)' : 'var(--hp-lo)';
  const chips = [];
  const st = mon.st;
  if (st.burn) chips.push(['bad', `灼傷${st.burn.lvl}級${st.burn.prog ? `（撲滅 ${st.burn.prog}）` : ''}`]);
  if (st.poison) chips.push(['bad', st.poison.bad ? '劇毒' : '中毒']);
  if (st.para) chips.push(['bad', '麻痺']);
  if (st.sleep) chips.push(['bad', `睡眠（${st.sleep.prog}/5）`]);
  if (st.freeze) chips.push(['bad', `冰凍（冰塊 ${st.freeze.hp}）`]);
  if (st.confuse) chips.push(['bad', mon.confusedRound ? '混亂（本輪受影響）' : '混亂']);
  if (st.flinch) chips.push(['bad', '畏縮']);
  if (st.infat) chips.push(['bad', '著迷']);
  if (st.disable) chips.push(['bad', `定身法：${moveInfo(DB, st.disable.move).name}`]);
  if (st.block) chips.push(['bad', '阻擋']);
  if (mon.charging) chips.push(['', `蓄力中：${moveInfo(DB, mon.charging.move).name}`]);
  if (mon.rechargeDebt) chips.push(['', `需要重新充能 ${mon.rechargeDebt}`]);
  if (mon.accPen) chips.push(['down', `命中 −${mon.accPen}`]);
  for (const [k, m] of Object.entries(mon.mods)) {
    const net = m.up - m.down + m.abil;
    if (m.up || m.down || m.abil) chips.push([net >= 0 ? 'up' : 'down', `${E.STAT_ZH[k]} ${E.stat(s, mon, k)}（${net >= 0 ? '+' : ''}${net}）`]);
  }
  const p = E.pain(mon);
  if (p) chips.push(['bad', `疼痛 −${p}`]);
  if (mon.willMode === 'seize') chips.push(['up', '把握機會']);
  const def = mon.def;
  return h('div', { class: `side ${sd === me ? 'me' : 'foe'}` },
    sprite(def.dex, 'sprite'),
    h('div', { class: 'info' },
      h('div', { class: 'row', style: { justifyContent: sd === me ? 'flex-start' : 'flex-end' } },
        h('span', { class: 'name' }, mon.name), mon.types.map(typeChip), h('span', { class: 'small muted' }, rankName(mon.rank))),
      h('div', { class: 'hpbar' }, h('div', { style: { width: `${pct * 100}%`, background: color } })),
      h('div', { class: 'small' }, `HP ${mon.hp}/${mon.maxHp}・意志 ${mon.will}/${mon.maxWill}・先攻 ${mon.init ?? '—'}`),
      h('div', { class: 'small dots', title: '本輪已用行動' }, '行動 ', '●'.repeat(mon.actions) + '○'.repeat(Math.max(0, 5 - mon.actions))),
      h('div', { class: 'chips' }, chips.map(([c, t]) => h('span', { class: `chip ${c}` }, t))),
      h('div', { class: 'small muted' }, `${side.name || sd}・`, h('span', { class: 'bench' }, side.team.map((m, i) => h('span', { class: `ball ${m.hp <= 0 ? 'out' : ''} ${i === side.active ? 'cur' : ''}`, title: sd === me || m.enteredRound >= 0 ? `${m.name} HP ${m.hp}/${m.maxHp}` : '？' })))),
      def.item ? h('div', { class: 'small muted' }, `道具：${def.item}`) : null,
      def.ability ? h('div', { class: 'small muted', title: DB.abilities[def.ability]?.e || '' }, `特性：${DB.abilities[def.ability]?.z || def.ability}`) : null,
    ));
}

function poolText(s, mon, info) {
  if (!info.acc) return '命中需手動';
  const a = info.acc.attrs.map((x) => (x === 'will' ? mon.maxWill : ['tough', 'cool', 'beauty', 'cute', 'clever'].includes(x) ? mon.def.social[x] || 0 : E.stat(s, mon, x)));
  const sk = info.acc.skills.map((x) => mon.def.skills[x] || 0);
  return `命中 ${Math.max(...a) + (sk.length ? Math.max(...sk) + (mon.rank >= 7 ? 2 : 0) : 0)} 顆`;
}

function viewBattle() {
  const r = APP.room, s = r.state, spect = !r.side, me = r.side || 'A', foe = E.other(me);
  const [btxt, mine] = bannerText(s, me, spect);
  const ex = E.expecting(s);
  const myMon = E.active(s, me);
  const myTurn = ex.phase === 'turn' && mine;
  const log = h('div', { class: 'panel log' }, s.log.map((l) => h('div', { class: l.kind }, l.text)));
  setTimeout(() => { log.scrollTop = log.scrollHeight; }, 0);
  // 需要我選擇時跳出視窗
  APP.modal = null;
  if (mine && ['lead', 'faintSwap', 'switcherSwap', 'endSwap', 'ice'].includes(ex.phase)) APP.modal = () => pickModal(ex.phase);
  else if (mine && ex.phase === 'react') APP.modal = () => reactModal();
  if (APP.switching && myTurn) APP.modal = () => switchModal(E.switchOptions(s, me));
  if (APP.manual && !spect) APP.modal = () => manualModal();

  const opts = myMon ? E.moveOptions(s, me).filter((o) => o.key !== EVASION && o.key !== CLASH) : [];
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(opts.length / perPage));
  if (APP.page >= pages) APP.page = 0;
  const shown = opts.slice(APP.page * perPage, APP.page * perPage + perPage);
  const moveBtns = h('div', { class: 'moves' }, shown.map((o) => {
    const i = o.info;
    const can = myTurn && o.ok && (i.acc || o.charging);
    return h('button', { class: 'mv', disabled: !can, title: `${o.why ? o.why + '\n' : ''}${i.text}`, style: { borderLeftColor: DB.typeColor[i.type] || '#888' },
      onclick: async () => {
        const m = APP.mods;
        const ok = await send({ type: 'move', move: o.key, count: m.count, mods: { acc: m.acc, dmg: m.dmg, push: m.push } });
        if (ok) APP.mods = { acc: 0, dmg: 0, push: false, count: 1 };
      } },
    h('b', {}, o.charging ? `釋放 ${i.name}` : i.name),
    h('span', {}, `${i.type || '無'}・${CAT[i.cat]}${i.dmg && !i.dmg.manual ? `・威力 ${i.dmg.power}` : ''}`), h('br'),
    h('span', {}, myMon ? poolText(s, myMon, i) : '', i.reaction ? `・${i.reaction.late ? '後制' : '先制'}${i.reaction.num}` : '', i.lowAcc ? `・低命中${i.lowAcc}` : '', i.successive > 1 ? `・連續×${i.successive}` : ''));
  }));
  const m = APP.mods;
  const stepper = (key, label) => h('span', {}, label, ' ',
    h('button', { class: 'small', onclick: () => { m[key]--; render(); } }, '−'), ` ${m[key] > 0 ? '+' : ''}${m[key]} `,
    h('button', { class: 'small', onclick: () => { m[key]++; render(); } }, '＋'));
  const modsRow = h('div', { class: 'mods' },
    stepper('acc', '命中骰'), stepper('dmg', '傷害骰'),
    h('label', {}, h('input', { type: 'checkbox', checked: m.push, onchange: (e) => { m.push = e.target.checked; } }), ' 推動命運（1 意志）'),
    h('span', {}, '連續行動次數 ', h('select', { onchange: (e) => { m.count = +e.target.value; } }, [1, 2, 3, 4, 5].map((n) => h('option', { value: n, selected: m.count === n }, n)))),
    h('span', { class: 'small muted' }, '（特性、道具、條件式加骰用；出招後歸零）'));
  const swOpts = E.switchOptions(s, me);
  const left = h('div', { class: 'col' },
    h('button', { disabled: !myTurn, onclick: () => send({ type: 'hold' }) }, '保留行動'),
    h('button', { disabled: !myMon || myMon.will < 1 || !!myMon.willMode || s.winner, onclick: () => send({ type: 'will', kind: 'seize' }), title: '花 1 意志點：本輪每次行動擲骰各重擲 1 顆失敗骰' }, '把握機會'),
    h('button', { disabled: !myMon || myMon.will < 1 || myMon.painIgnore >= 2 || s.winner, onclick: () => send({ type: 'will', kind: 'pain' }), title: '花 1 意志點：本場忽略 1 級疼痛懲罰' }, '挺過疼痛'));
  const right = h('div', { class: 'col' },
    h('button', { disabled: !myTurn || !swOpts.length || (myMon && myMon.charging), onclick: () => { APP.switching = true; render(); } }, '換寶可夢'),
    h('button', { onclick: () => { APP.manual = { target: me }; render(); } }, '手動調整'),
    h('button', { disabled: !!s.winner, onclick: () => { if (confirm('確定要投降？')) send({ type: 'forfeit' }); } }, '投降'));
  return h('div', {},
    h('div', { class: 'topbar' },
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: leave }, '← 離開'), h('span', { class: 'muted' }, `房號 ${r.code}・第 ${s.round} 戰鬥輪`)),
      h('div', { class: `banner ${mine ? 'mine' : ''}` }, btxt)),
    h('div', { class: 'battle' },
      h('div', {},
        h('div', { class: 'panel field' }, monPanel(s, foe, me),
          s.weather ? h('div', { class: 'weather' }, `天氣：${E.WEATHER_ZH[s.weather.kind]}${s.weather.rounds ? `（剩 ${s.weather.rounds} 輪）` : ''}`) : null,
          monPanel(s, me, me)),
        h('div', { class: 'panel' }, modsRow,
          h('div', { class: 'controls' }, left, h('div', {}, moveBtns,
            pages > 1 ? h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'small', onclick: () => { APP.page = (APP.page + 1) % pages; render(); } }, `切換招式行（${APP.page + 1}/${pages}）`)) : null), right))),
      log));
}

// ───────── 視窗 ─────────
function modal(title, ...body) {
  return h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { style: { marginTop: 0 } }, title), body));
}
function monButton(mon, onclick) {
  return h('button', { onclick }, h('div', { class: 'row' }, sprite(mon.def.dex), h('div', {}, h('b', {}, mon.name), ' ', mon.types.map(typeChip),
    h('div', { class: 'small muted' }, `HP ${mon.hp}/${mon.maxHp}・${rankName(mon.rank)}`))));
}
function pickModal(phase) {
  const r = APP.room, s = r.state, me = r.side;
  const team = s.sides[me].team;
  if (phase === 'ice') {
    const mon = E.active(s, me);
    return modal('打破冰塊', h('p', { class: 'small' }, '選一個招式攻擊困住你的冰塊。格鬥、火、岩石、鋼系招式可以一下打破；其他招式擲傷害骰扣冰塊的 HP。不擲命中、不消耗行動。'),
      h('div', { class: 'opts' }, mon.def.moves.map((k) => { const i = moveInfo(DB, k); return h('button', { disabled: !i.dmg || i.dmg.manual, onclick: () => send({ type: 'ice', move: k }) }, `${i.name}（${i.type}）`); }),
        h('button', { onclick: () => send({ type: 'ice', move: null }) }, '不打')));
  }
  const title = { lead: '選擇首發', faintSwap: '派出下一隻', switcherSwap: '選擇換上的寶可夢', endSwap: '戰鬥輪結束：要換寶可夢嗎？' }[phase];
  const note = phase === 'endSwap' ? '對手看不到你選了什麼，雙方都決定後同時生效。換上的寶可夢下一輪可以正常行動。'
    : phase === 'faintSwap' && s.resume && s.resume.mid ? '戰鬥輪中途上場，本輪不能行動。' : '';
  const cand = team.map((m, i) => [m, i]).filter(([m, i]) => m.hp > 0 && (phase === 'lead' || i !== s.sides[me].active));
  const kind = phase === 'lead' ? 'lead' : 'swap';
  return modal(title, note ? h('p', { class: 'small muted' }, note) : null,
    h('div', { class: 'opts' }, cand.map(([m, i]) => monButton(m, () => send({ type: kind, idx: i }))),
      phase === 'endSwap' || (phase === 'switcherSwap' && !s.resume?.forced) ? h('button', { onclick: () => send({ type: 'swap', idx: null }) }, '不換') : null));
}
function switchModal(list) {
  const r = APP.room, s = r.state;
  return modal('換寶可夢', h('p', { class: 'small muted' }, `用這個回合替換，不消耗行動；換上的寶可夢本輪不能行動也不能反應。本輪還可以換 ${2 - s.sides[r.side].switches} 次。`),
    h('div', { class: 'opts' }, list.map((i) => monButton(s.sides[r.side].team[i], async () => { APP.switching = false; await send({ type: 'switch', idx: i }); render(); })),
      h('button', { onclick: () => { APP.switching = false; render(); } }, '取消')));
}
function reactModal() {
  const r = APP.room, s = r.state, me = r.side;
  const ch = s.chain;
  const atk = E.active(s, ch.actor === me ? E.other(me) : ch.actor);
  const target = ch.awaitAgainst === 'main' ? { name: ch.info.name, net: ch.hits.find((x) => x.ok)?.net } : { name: ch.reactions[ch.awaitAgainst].info.name, net: ch.reactions[ch.awaitAgainst].net };
  const opts = E.reactionOptions(s, me);
  const mon = E.active(s, me);
  const rm = APP.rmods || (APP.rmods = { acc: 0, push: false });
  const go = async (o) => { const ok = await send({ type: 'react', kind: o.kind, move: o.key, mods: { acc: rm.acc, push: rm.push } }); if (ok) APP.rmods = null; };
  const label = (o) => {
    if (o.kind === 'evade') return `閃避（靈巧＋閃避 ${E.stat(s, mon, 'dex') + (mon.def.skills.evasion || 0)} 顆，需要 ${o.need} 成功）`;
    const i = moveInfo(DB, o.key);
    if (o.kind === 'clash') return `用${i.name}對抗（${i.cat === 'phys' ? '力量' : '特殊'}＋對抗 ${E.stat(s, mon, i.cat === 'phys' ? 'str' : 'spe') + (mon.def.skills.clash || 0)} 顆，需要 ${o.need} 成功）`;
    return `${o.kind === 'shield' ? '護盾' : i.reaction.late ? '後制反應' : '先制反應'}：${i.name}（${poolText(s, mon, i)}，需要 ${o.need} 成功）`;
  };
  return modal(`${atk.name} 的${target.name}命中了（${target.net} 成功）`,
    h('p', { class: 'small muted' }, `你已用 ${mon.actions}/5 個行動。反應會消耗一個行動；閃避和對抗不受多重行動難度影響。`),
    h('div', { class: 'mods' },
      h('span', {}, '骰數調整 ', h('button', { class: 'small', onclick: () => { rm.acc--; render(); } }, '−'), ` ${rm.acc} `, h('button', { class: 'small', onclick: () => { rm.acc++; render(); } }, '＋')),
      h('label', {}, h('input', { type: 'checkbox', checked: rm.push, onchange: (e) => { rm.push = e.target.checked; } }), ' 推動命運')),
    h('div', { class: 'opts' }, opts.map((o) => h('button', { onclick: () => go(o) }, label(o))),
      h('button', { onclick: () => go({ kind: 'none' }) }, '不反應')));
}

function manualModal() {
  const r = APP.room, s = r.state, me = r.side;
  const st = APP.manual;
  const mon = E.active(s, st.target);
  const close = () => { APP.manual = null; render(); };
  const doIt = (intent) => send({ type: 'manual', target: st.target, ...intent });
  const hpIn = h('input', { type: 'number', value: mon.hp, min: 0, max: mon.maxHp });
  const willIn = h('input', { type: 'number', value: mon.will, min: 0, max: mon.maxWill });
  const actIn = h('input', { type: 'number', value: mon.actions, min: 0, max: 5 });
  const accIn = h('input', { type: 'number', value: mon.accPen, min: 0, max: 5 });
  const STS = [['burn', '灼傷'], ['poison', '中毒'], ['badPoison', '劇毒'], ['para', '麻痺'], ['sleep', '睡眠'], ['freeze', '冰凍'], ['confuse', '混亂'], ['flinch', '畏縮'], ['infat', '著迷'], ['block', '阻擋']];
  const has = (k) => k === 'badPoison' ? mon.st.poison && mon.st.poison.bad : k === 'poison' ? mon.st.poison && !mon.st.poison.bad : !!mon.st[k];
  const burnLv = h('select', {}, [1, 2, 3].map((n) => h('option', { value: n }, `${n} 級`)));
  const disIn = h('select', {}, mon.def.moves.map((k) => h('option', { value: k }, moveInfo(DB, k).name)));
  const noteIn = h('input', { placeholder: '寫一句說明（例：特性「靜電」發動）', style: { width: '100%' } });
  const wSel = h('select', {}, h('option', { value: '' }, '無'), Object.entries(E.WEATHER_ZH).map(([k, z]) => h('option', { value: k, selected: s.weather && s.weather.kind === k }, z)));
  const wRounds = h('input', { type: 'number', value: 4, min: 0, max: 20 });
  return modal('手動調整',
    h('p', { class: 'small muted' }, '雙方都看得到每一次手動調整的紀錄。'),
    h('div', { class: 'tabs' }, [[me, '我方'], [E.other(me), '對方']].map(([sd, z]) => h('button', { class: st.target === sd ? 'on' : '', onclick: () => { st.target = sd; render(); } }, `${z}：${E.active(s, sd).name}`))),
    h('div', { class: 'row' }, 'HP', hpIn, h('button', { class: 'small', onclick: () => doIt({ op: 'hp', value: +hpIn.value }) }, '設定'),
      '意志', willIn, h('button', { class: 'small', onclick: () => doIt({ op: 'will', value: +willIn.value }) }, '設定')),
    h('div', { class: 'row', style: { marginTop: '6px' } }, '本輪已用行動', actIn, h('button', { class: 'small', onclick: () => doIt({ op: 'actions', value: +actIn.value }) }, '設定'),
      '命中扣成功', accIn, h('button', { class: 'small', onclick: () => doIt({ op: 'accPen', value: +accIn.value }) }, '設定')),
    h('h3', {}, '異常狀態'),
    h('div', { class: 'row' }, STS.map(([k, z]) => h('button', { class: `small ${has(k) ? 'primary' : ''}`, onclick: () => doIt({ op: 'status', status: k, on: !has(k), lvl: k === 'burn' ? +burnLv.value : undefined }) }, z)), '灼傷等級', burnLv),
    h('div', { class: 'row', style: { marginTop: '6px' } }, '定身法', disIn, h('button', { class: 'small', onclick: () => doIt({ op: 'status', status: 'disable', on: true, move: disIn.value, rounds: 4 }) }, '禁用（4 輪）'),
      mon.st.disable ? h('button', { class: 'small', onclick: () => doIt({ op: 'status', status: 'disable', on: false }) }, '解除') : null),
    h('h3', {}, '能力值調整', h('span', { class: 'small muted' }, '（招式提升／招式降低只取最大值；特性等可疊加，可填負數）')),
    h('table', { class: 'stats' }, h('tr', {}, h('td'), h('td', {}, '招式提升'), h('td', {}, '招式降低'), h('td', {}, '特性等'), h('td', {}, '目前'), h('td')),
      Object.entries(E.STAT_ZH).map(([k, z]) => {
        const md = mon.mods[k];
        const up = h('input', { type: 'number', value: md.up, min: 0, max: 9 }), dn = h('input', { type: 'number', value: md.down, min: 0, max: 9 }), ab = h('input', { type: 'number', value: md.abil, min: -9, max: 9 });
        return h('tr', {}, h('td', {}, z), h('td', {}, up), h('td', {}, dn), h('td', {}, ab), h('td', {}, E.stat(s, mon, k)),
          h('td', {}, h('button', { class: 'small', onclick: () => doIt({ op: 'stat', stat: k, up: +up.value, down: +dn.value, abil: +ab.value }) }, '設定')));
      })),
    h('h3', {}, '天氣'),
    h('div', { class: 'row' }, wSel, '持續', wRounds, '輪（0＝不限）', h('button', { class: 'small', onclick: () => doIt({ op: 'weather', weather: wSel.value || null, rounds: +wRounds.value || null }) }, '設定')),
    h('h3', {}, '紀錄說明'),
    h('div', { class: 'row' }, noteIn, h('button', { class: 'small', onclick: () => { if (noteIn.value.trim()) doIt({ op: 'note', text: noteIn.value.trim() }); } }, '寫入紀錄')),
    h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'flex-end' } }, h('button', { class: 'primary', onclick: close }, '關閉')));
}

boot();
