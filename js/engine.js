// Pokerole 3.0 單打對戰規則引擎
// 狀態由事件（玩家決定＋擲出的骰面）重算，雙方畫面因此一致，斷線重連也能還原。
// 用法：
//   setDB(db)
//   let s = newGame(settings)
//   const { state, event } = act(s, intent)   // 現場擲骰，回傳要存進紀錄的 event
//   s = replay(settings, events)              // 由紀錄重算
import { moveInfo, clashable, evadable, FOE_TARGETS, EVASION, CLASH, STRUGGLE, SOCIAL } from './moves.js';

export const ENGINE_VER = 1;
let DB = null;
export function setDB(db) { DB = db; }
export const SIDES = ['A', 'B'];
export const other = (sd) => (sd === 'A' ? 'B' : 'A');
const MAX_ACTIONS = 5;
const STAT_KEYS = ['str', 'dex', 'vit', 'spe', 'ins', 'def', 'spdef'];
const STATUS_ZH = { burn: '灼傷', poison: '中毒', badPoison: '劇毒', para: '麻痺', sleep: '睡眠', freeze: '冰凍',
  confuse: '混亂', flinch: '畏縮', infat: '著迷', disable: '定身法', block: '阻擋' };
const WEATHER_ZH = { sun: '大晴天', rain: '下雨', sand: '沙暴', snow: '下雪', hail: '冰雹' };
const STAT_ZH = { str: '力量', dex: '靈巧', vit: '體魄', spe: '特殊', ins: '洞察', def: '防禦', spdef: '特防' };
export { STATUS_ZH, WEATHER_ZH, STAT_ZH };

// ───────── 建立遊戲 ─────────
export function newGame(settings = {}) {
  return {
    settings: { defMode: 1, hpStat: 'vit', teamSize: 3, ...settings },
    phase: 'setup', round: 0, turnNo: 0, order: ['A', 'B'], turnIdx: 0, turnStarted: false, passStreak: 0,
    weather: null, chain: null, await: {}, picks: {}, resume: null, winner: null, log: [],
    sides: { A: newSide(), B: newSide() },
  };
}
function newSide() { return { name: '', team: null, active: -1, switches: 0, switcherUsed: false }; }

// 隊伍成員的定義（由建隊畫面產生）：
// { dex, nick, rank, attr:{str,dex,vit,spe,ins}, social:{tough,cool,beauty,cute,clever},
//   skills:{brawl,...}, loyalty, happiness, ability, item, moves:[key...] }
function makeMon(def, settings, idx) {
  const dx = DB.dex[def.dex];
  const a = def.attr;
  const master = def.rank >= 7 ? 3 : 0;
  const hpAttr = settings.defMode === 2 && settings.hpStat === 'ins' ? a.ins : a.vit;
  const maxHp = dx.hp + hpAttr + master;
  const maxWill = a.ins + 3 + master;
  return {
    idx, def, name: def.nick || dx.z, types: dx.ty.slice(), rank: def.rank,
    maxHp, hp: maxHp, maxWill, will: maxWill, init: null, initVal: a.dex + (def.skills.alert || 0) + master,
    actions: 0, used: [], reactedTurn: -1, enteredRound: -1, enteredMid: false, healed: 0,
    mods: blankMods(), accPen: 0, painIgnore: 0, willMode: null,
    st: {}, charging: null, rechargeDebt: 0, lastShieldRound: -9, shieldStreak: 0, confusedRound: false,
  };
}
function blankMods() { const m = {}; for (const k of STAT_KEYS) m[k] = { up: 0, down: 0, abil: 0 }; return m; }

// ───────── 骰子 ─────────
function makeCtx(s, tape) {
  const live = !tape;
  const t = tape ? tape.slice() : [];
  let i = 0;
  return {
    s, tape: t,
    d6() {
      if (!live) { if (i >= t.length) throw new Error('紀錄的骰子不夠，紀錄可能損壞'); return t[i++]; }
      const v = 1 + Math.floor(Math.random() * 6); t.push(v); return v;
    },
    roll(n) { const r = []; for (let k = 0; k < n; k++) r.push(this.d6()); return r; },
    log(text, kind = 'info') { s.log.push({ r: s.round, text, kind }); },
  };
}
const succ = (dice) => dice.filter((d) => d >= 4).length;
const showDice = (dice) => dice.length ? '[' + dice.join(' ') + ']' : '[]';

// ───────── 數值 ─────────
export function active(s, sd) { const side = s.sides[sd]; return side.team && side.active >= 0 ? side.team[side.active] : null; }
function baseOf(mon, k, s) {
  const a = mon.def.attr;
  if (k === 'def') return a.vit;
  if (k === 'spdef') return s.settings.defMode === 2 ? a.ins : a.vit;
  return a[k] ?? 0;
}
export function stat(s, mon, k) {
  const base = baseOf(mon, k, s);
  const m = mon.mods[k];
  const net = m.up - m.down;
  let v = base + net;
  if (net < 0) v = Math.max(v, Math.min(base, 1));
  if (net > 0) v = Math.min(v, Math.max(base, 10));
  v += m.abil;
  if (k === 'dex' && mon.st.para) v -= 2;
  if (mon.rank >= 7 && (k === 'def' || k === 'spdef')) v += 3;
  if (s.weather) {
    if (s.weather.kind === 'sand' && k === 'spdef' && mon.types.includes('岩石')) v += 1;
    if (s.weather.kind === 'snow' && k === 'def' && mon.types.includes('冰')) v += 1;
  }
  return Math.max(0, v);
}
function attrVal(s, mon, a) {
  if (a === 'will') return mon.maxWill;
  if (SOCIAL.includes(a)) return mon.def.social[a] || 0;
  return stat(s, mon, a);
}
export function pain(mon) {
  let p = 0;
  if (mon.hp <= 1) p = 2;
  else if (mon.hp <= Math.floor(mon.maxHp / 2)) p = 1;
  return Math.max(0, p - mon.painIgnore);
}
function confusionPen(mon) { return mon.rank >= 7 ? 3 : mon.rank >= 4 ? 2 : 1; }
function bestPool(s, mon, pool) {
  // 二擇一時取較高者
  const a = pool.attrs.reduce((b, x) => (attrVal(s, mon, x) > attrVal(s, mon, b) ? x : b), pool.attrs[0]);
  const sk = pool.skills.length ? pool.skills.reduce((b, x) => ((mon.def.skills[x] || 0) > (mon.def.skills[b] || 0) ? x : b), pool.skills[0]) : null;
  const n = attrVal(s, mon, a) + (sk ? (mon.def.skills[sk] || 0) + (mon.rank >= 7 ? 2 : 0) : 0);
  return { attr: a, skill: sk, n };
}
export function typeEff(type, defTypes) {
  if (!type) return 0;
  let score = 0;
  for (const t of defTypes) {
    const c = DB.chart[t];
    if (!c) continue;
    if (c.i.includes(type)) return null; // 免疫
    if (c.w.includes(type)) score++;
    if (c.r.includes(type)) score--;
  }
  return score;
}
function canAct(s, mon) {
  return mon && mon.hp > 0 && mon.actions < MAX_ACTIONS && !(mon.enteredMid && mon.enteredRound === s.round) && !mon.st.freeze;
}
function canReact(s, mon) {
  return canAct(s, mon) && !mon.st.sleep && !mon.st.flinch && mon.reactedTurn !== s.turnNo;
}

// 一次行動擲骰（命中、閃避、對抗、反應）
function actionRoll(ctx, mon, poolInfo, opts = {}) {
  const s = ctx.s;
  const n = Math.max(0, poolInfo.n + (opts.extraDice || 0));
  const dice = ctx.roll(n);
  let rerolled = null;
  if (mon.willMode === 'seize') {
    const fi = dice.findIndex((d) => d < 4);
    if (fi >= 0) { rerolled = dice[fi]; dice[fi] = ctx.d6(); }
  }
  const raw = succ(dice);
  const usesPain = !['vit', 'will'].includes(poolInfo.attr);
  const pens = (opts.lowAcc || 0) + (usesPain ? pain(mon) : 0) + (mon.confusedRound && mon.st.confuse ? confusionPen(mon) : 0) + (opts.extraPen || 0);
  let net = Math.max(0, raw - pens);
  if (opts.push) { mon.will--; mon.willMode = 'push'; net += 1; }
  const parts = [`${showDice(dice)}${rerolled !== null ? `（把握機會重擲 ${rerolled}）` : ''} ${raw} 成功`];
  if (pens) parts.push(`−${pens}`);
  if (opts.push) parts.push('＋1（推動命運）');
  return { dice, raw, net, text: parts.join(' ') + ` → ${net}` };
}

// ───────── 對外：可用的操作 ─────────
export function expecting(s) {
  // 回傳目前在等哪一方、等什麼
  if (s.winner) return { phase: 'over', sides: [] };
  if (s.phase === 'setup') return { phase: 'setup', sides: SIDES.filter((x) => !s.sides[x].team) };
  if (['lead', 'faintSwap', 'endSwap', 'switcherSwap', 'ice'].includes(s.phase)) return { phase: s.phase, sides: SIDES.filter((x) => s.await[x] && s.picks[x] === undefined) };
  if (s.phase === 'react') return { phase: 'react', sides: [s.chain.awaiting] };
  if (s.phase === 'turn') return { phase: 'turn', sides: [s.order[s.turnIdx]] };
  return { phase: s.phase, sides: [] };
}

export function moveOptions(s, sd) {
  const mon = active(s, sd);
  if (!mon) return [];
  const keys = [...mon.def.moves, STRUGGLE];
  return keys.map((k) => {
    const info = moveInfo(DB, k);
    let why = '';
    if (mon.charging) why = mon.charging.move === k ? '' : '必須先釋放蓄力招式';
    else if (mon.used.includes(k)) why = '本輪已使用';
    else if (mon.st.disable && mon.st.disable.move === k) why = '被定身法禁用';
    else if (info.reaction && info.shield && mon.lastShieldRound === s.round) why = '本輪已用過護盾招式';
    return { key: k, info, ok: !why, why, charging: mon.charging && mon.charging.move === k };
  });
}

export function switchOptions(s, sd, mode = 'turn') {
  const side = s.sides[sd];
  if (!side.team) return [];
  const cur = active(s, sd);
  if (mode === 'turn' && (side.switches >= 2 || (cur && cur.st.block))) return [];
  return side.team.map((m, i) => i).filter((i) => i !== side.active && side.team[i].hp > 0);
}

// 防守方或反制方能選的反應
export function reactionOptions(s, sd) {
  const ch = s.chain;
  if (!ch || ch.awaiting !== sd) return [];
  const mon = active(s, sd);
  if (!canReact(s, mon)) return [];
  const against = ch.awaitAgainst; // 'main' 或反應編號
  const tgt = against === 'main' ? ch : ch.reactions[against];
  const tinfo = tgt.info;
  const tReac = against === 'main' ? null : tgt.info.reaction; // 對方是反應時，要比數字
  const allowNum = (late, num) => {
    if (!tReac) return true;
    if (tReac.late) return late && num > tReac.num;
    return late || num > tReac.num;
  };
  const opts = [];
  const hitNet = against === 'main' ? ch.hits.find((h) => h.ok)?.net : tgt.net;
  if (evadable(tinfo) && allowNum(false, 6)) opts.push({ kind: 'evade', key: EVASION, need: hitNet });
  if (clashable(tinfo) && allowNum(false, 6)) {
    for (const o of moveOptions(s, sd)) {
      if (!o.ok || o.charging || !clashable(o.info)) continue;
      if ((tinfo.target === 'area') !== (o.info.target === 'area') && tinfo.target === 'area') continue;
      opts.push({ kind: 'clash', key: o.key, need: hitNet });
    }
  }
  for (const o of moveOptions(s, sd)) {
    if (!o.ok || !o.info.reaction || o.key === EVASION || o.key === CLASH) continue;
    if (!allowNum(o.info.reaction.late, o.info.reaction.num)) continue;
    opts.push({ kind: o.info.shield ? 'shield' : 'move', key: o.key, need: mon.actions + 1 });
  }
  return opts;
}

// ───────── 主要入口 ─────────
export function act(s0, intent) {
  const s = structuredClone(s0);
  const ctx = makeCtx(s, null);
  handle(ctx, intent);
  return { state: s, event: { intent, tape: ctx.tape } };
}
export function applyEvent(s0, ev) {
  const s = structuredClone(s0);
  const ctx = makeCtx(s, ev.tape || []);
  handle(ctx, ev.intent);
  return s;
}
export function replay(settings, events) {
  let s = newGame(settings);
  for (const ev of events) s = applyEvent(s, ev);
  return s;
}

function fail(msg) { const e = new Error(msg); e.rule = true; throw e; }

function handle(ctx, it) {
  const s = ctx.s;
  if (s.winner && it.type !== 'manual') fail('對戰已結束');
  const H = {
    name: () => { s.sides[it.side].name = String(it.name || '').slice(0, 20); },
    team: () => doTeam(ctx, it),
    lead: () => pick(ctx, it, 'lead'),
    move: () => doMove(ctx, it),
    hold: () => doHold(ctx, it),
    switch: () => doSwitch(ctx, it),
    react: () => doReact(ctx, it),
    swap: () => pick(ctx, it, null),
    ice: () => pick(ctx, it, 'ice'),
    will: () => doWill(ctx, it),
    manual: () => doManual(ctx, it),
    forfeit: () => { s.winner = other(it.side); ctx.log(`${s.sides[it.side].name || it.side} 投降。`, 'big'); },
  };
  if (!H[it.type]) fail('未知的操作：' + it.type);
  H[it.type]();
  advance(ctx);
}

// ───────── 開戰前 ─────────
function doTeam(ctx, it) {
  const s = ctx.s;
  if (s.phase !== 'setup') fail('對戰已開始，不能換隊伍');
  const team = it.team;
  if (!Array.isArray(team) || team.length < 1 || team.length > 6) fail('隊伍要有 1–6 隻');
  if (team.length > s.settings.teamSize) fail(`這個房間每方最多 ${s.settings.teamSize} 隻`);
  for (const d of team) {
    if (!DB.dex[d.dex]) fail('隊伍裡有不存在的寶可夢');
    if (!Array.isArray(d.moves) || !d.moves.length) fail(`${d.nick || DB.dex[d.dex].z} 至少要有一個招式`);
    if (d.moves.some((k) => !DB.moves[k])) fail('隊伍裡有不存在的招式');
  }
  if (it.name) s.sides[it.side].name = String(it.name).slice(0, 20);
  s.sides[it.side].team = team.map((d, i) => makeMon(d, s.settings, i));
  ctx.log(`${s.sides[it.side].name || it.side} 選好了隊伍（${team.length} 隻）。`);
  if (SIDES.every((x) => s.sides[x].team)) { s.phase = 'lead'; s.await = { A: true, B: true }; s.picks = {}; }
}

function pick(ctx, it, kind) {
  const s = ctx.s;
  const phase = s.phase;
  if (kind === 'lead' && phase !== 'lead') fail('現在不是選首發的時候');
  if (kind === 'ice' && phase !== 'ice') fail('現在不是打破冰塊的時候');
  if (!kind && !['faintSwap', 'endSwap', 'switcherSwap'].includes(phase)) fail('現在不能換寶可夢');
  if (!s.await[it.side]) fail('現在不需要你選擇');
  if (s.picks[it.side] !== undefined) fail('你已經選過了');
  const side = s.sides[it.side];
  if (phase === 'ice') {
    if (it.move != null && !active(s, it.side).def.moves.includes(it.move)) fail('沒有這個招式');
  } else if (it.idx === null || it.idx === undefined) {
    if (phase === 'lead' || phase === 'faintSwap' || (phase === 'switcherSwap' && s.resume.forced)) fail('必須選一隻寶可夢');
  } else {
    const m = side.team[it.idx];
    if (!m || m.hp <= 0) fail('這隻寶可夢不能上場');
    if (phase !== 'lead' && it.idx === side.active) fail('牠已經在場上了');
  }
  s.picks[it.side] = phase === 'ice' ? (it.move ?? null) : (it.idx ?? null);
  if (SIDES.some((x) => s.await[x] && s.picks[x] === undefined)) return; // 等另一方
  const picks = s.picks; s.picks = {}; s.await = {};
  if (phase === 'lead') {
    for (const sd of SIDES) enter(ctx, sd, picks[sd], false);
    ctx.log('對戰開始！', 'big');
    startRound(ctx);
  } else if (phase === 'faintSwap') {
    for (const sd of SIDES) if (picks[sd] !== undefined) enter(ctx, sd, picks[sd], s.resume.mid);
    resume(ctx);
  } else if (phase === 'switcherSwap') {
    for (const sd of SIDES) if (picks[sd] !== undefined && picks[sd] !== null) enter(ctx, sd, picks[sd], true, true);
    resume(ctx);
  } else if (phase === 'ice') {
    for (const sd of SIDES) if (picks[sd] !== undefined) breakIce(ctx, sd, picks[sd]);
    afterRoundEndDamage(ctx, 'endSwap');
  } else if (phase === 'endSwap') {
    for (const sd of SIDES) if (picks[sd] !== undefined && picks[sd] !== null) enter(ctx, sd, picks[sd], false);
    startRound(ctx);
  }
}

// 派寶可夢上場。mid=戰鬥輪中途（本輪不能行動）；keep=替換招式（保留先攻與剩餘行動）
function enter(ctx, sd, idx, mid, keep = false) {
  const s = ctx.s;
  const side = s.sides[sd];
  const out = active(s, sd);
  const inn = side.team[idx];
  if (out && out !== inn) { recall(out); if (out.hp > 0 && !mid) ctx.log(`${side.name || sd} 收回了 ${out.name}。`); }
  if (keep && out) { inn.savedInit = inn.init; inn.tempInit = true; inn.init = out.init; inn.actions = out.actions; inn.used = []; }
  side.active = idx;
  inn.enteredRound = s.round;
  inn.enteredMid = mid && !keep;
  ctx.log(`${side.name || sd} 派出了 ${inn.name}！`);
}
function recall(mon) {
  // 收回：能力升降、揮發型異常狀態、蓄力都清除（重新充能保留）
  mon.mods = blankMods();
  mon.accPen = 0;
  for (const k of ['confuse', 'flinch', 'infat', 'disable', 'block']) delete mon.st[k];
  mon.charging = null;
  mon.confusedRound = false;
}

// ───────── 戰鬥輪 ─────────
function startRound(ctx) {
  const s = ctx.s;
  s.round++;
  ctx.log(`── 第 ${s.round} 戰鬥輪 ──`, 'round');
  for (const sd of SIDES) {
    const side = s.sides[sd];
    side.switches = 0; side.switcherUsed = false;
    for (const m of side.team) {
      m.actions = 0; m.used = []; m.healed = 0; m.willMode = null; m.confusedRound = false; m.flinchRound = false;
      m.burnTried = false;
      if (m.tempInit) { m.init = m.savedInit ?? null; m.tempInit = false; }
      delete m.st.flinch; // #8 畏縮不跨輪
    }
    const mon = active(s, sd);
    if (mon.rechargeDebt) {
      mon.actions = Math.min(MAX_ACTIONS, mon.rechargeDebt);
      ctx.log(`${mon.name} 需要重新充能，用掉了 ${mon.actions} 個行動。`);
      mon.rechargeDebt = 0;
    }
    if (mon.init === null) {
      const d = ctx.d6();
      mon.init = mon.initVal + d;
      ctx.log(`${mon.name} 擲先攻：先攻值 ${mon.initVal} ＋ [${d}] ＝ ${mon.init}`);
    }
    if (mon.st.confuse) {
      const r = ctx.roll(stat(s, mon, 'ins'));
      const n = Math.max(0, succ(r) - confusionPen(mon));
      mon.confusedRound = n < 2;
      ctx.log(`${mon.name} 混亂判定（洞察）：${showDice(r)} → ${n} 成功，${mon.confusedRound ? '本輪仍然混亂' : '本輪可以正常行動'}。`);
    }
  }
  // 決定順序
  const [a, b] = SIDES.map((x) => active(s, x));
  let first = 'A';
  if (a.init !== b.init) first = a.init > b.init ? 'A' : 'B';
  else if (a.initVal !== b.initVal) first = a.initVal > b.initVal ? 'A' : 'B';
  else {
    for (;;) { const x = ctx.d6(), y = ctx.d6(); if (x !== y) { first = x > y ? 'A' : 'B'; ctx.log(`先攻平手，重擲：${x} 對 ${y}`); break; } }
  }
  s.order = [first, other(first)];
  s.turnIdx = 0; s.passStreak = 0; s.turnStarted = false; s.phase = 'turn';
}

function nextTurn(ctx, passed) {
  const s = ctx.s;
  if (passed) s.passStreak++; else s.passStreak = 0;
  s.turnStarted = false;
  s.turnNo++;
  if (s.passStreak >= 2) { s.phase = 'roundEnd'; return; }
  s.turnIdx = (s.turnIdx + 1) % 2;
}

// 自動推進：處理不需要玩家決定的步驟
function advance(ctx) {
  const s = ctx.s;
  for (let guard = 0; guard < 200; guard++) {
    if (s.winner) return;
    if (s.phase === 'roundEnd') { roundEnd(ctx); continue; }
    if (s.phase !== 'turn' || s.turnStarted) return;
    const sd = s.order[s.turnIdx];
    const mon = active(s, sd);
    s.turnStarted = true;
    // 灼傷的撲滅檢定：每輪第一次輪到牠時自動擲，不消耗行動
    if (mon.st.burn && !mon.burnTried && mon.hp > 0 && !(mon.enteredMid && mon.enteredRound === s.round)) {
      mon.burnTried = true;
      const r = ctx.roll(stat(s, mon, 'dex') + (mon.def.skills.athletic || 0));
      const n = Math.max(0, succ(r) - pain(mon));
      mon.st.burn.prog += n;
      const need = [0, 4, 6, 8][mon.st.burn.lvl];
      if (mon.st.burn.prog >= need) { delete mon.st.burn; ctx.log(`${mon.name} 撲滅了火焰！（${showDice(r)}）`); }
      else ctx.log(`${mon.name} 試著撲滅火焰：${showDice(r)} ${n} 成功（累計 ${mon.st.burn.prog}/${need}）`);
    }
    if (!canAct(s, mon)) { nextTurn(ctx, true); continue; }
    if (mon.st.sleep) {
      mon.actions++;
      const r = ctx.roll(stat(s, mon, 'ins'));
      mon.st.sleep.prog += succ(r);
      if (mon.st.sleep.prog >= 5) { delete mon.st.sleep; ctx.log(`${mon.name} 醒過來了！（${showDice(r)}）下個回合才能行動。`); }
      else ctx.log(`${mon.name} 正在睡覺… 清醒判定 ${showDice(r)}（累計 ${mon.st.sleep.prog}/5）`);
      nextTurn(ctx, false); continue;
    }
    if (mon.st.flinch) {
      mon.actions++;
      delete mon.st.flinch;
      ctx.log(`${mon.name} 畏縮了，浪費了一個行動。`);
      nextTurn(ctx, false); continue;
    }
    return; // 等玩家
  }
  throw new Error('引擎推進次數過多');
}

function roundEnd(ctx) {
  const s = ctx.s;
  ctx.log(`第 ${s.round} 戰鬥輪結束。`, 'round');
  for (const sd of SIDES) {
    const mon = active(s, sd);
    if (!mon || mon.hp <= 0) continue;
    const st = mon.st;
    if (st.burn) {
      const d = st.burn.lvl === 3 ? 3 + st.burn.rounds : st.burn.lvl;
      st.burn.rounds++;
      hurt(ctx, mon, d, `${STATUS_ZH.burn}${st.burn.lvl}級`);
    }
    if (st.poison) {
      const d = st.poison.bad ? 2 + st.poison.rounds : 2;
      st.poison.rounds++;
      hurt(ctx, mon, d, st.poison.bad ? '劇毒' : '中毒');
    }
    const w = s.weather && s.weather.kind;
    if (w === 'sand' && !mon.types.some((t) => ['岩石', '地面', '鋼'].includes(t))) hurt(ctx, mon, 1, '沙暴');
    if (w === 'hail' && !mon.types.includes('冰')) hurt(ctx, mon, 1, '冰雹');
    if (st.disable && st.disable.rounds != null && --st.disable.rounds <= 0) { delete st.disable; ctx.log(`${mon.name} 的定身法解除了。`); }
  }
  if (s.weather && s.weather.rounds != null && --s.weather.rounds <= 0) { ctx.log(`${WEATHER_ZH[s.weather.kind]}結束了。`); s.weather = null; }
  if (checkFaint(ctx, { phase: 'afterRoundEnd', mid: false })) return;
  afterRoundEndDamage(ctx, 'ice');
}

// 戰鬥輪結束後的兩個選擇：打冰塊 → 換寶可夢
function afterRoundEndDamage(ctx, stage) {
  const s = ctx.s;
  if (stage === 'ice') {
    const frozen = SIDES.filter((sd) => active(s, sd).st.freeze);
    if (frozen.length) { s.phase = 'ice'; s.await = {}; s.picks = {}; for (const sd of frozen) s.await[sd] = true; return; }
  }
  const can = SIDES.filter((sd) => switchOptions(s, sd, 'end').length && !active(s, sd).st.block);
  if (can.length) { s.phase = 'endSwap'; s.await = {}; s.picks = {}; for (const sd of can) s.await[sd] = true; return; }
  startRound(ctx);
}

function resume(ctx) {
  const s = ctx.s;
  const r = s.resume; s.resume = null;
  if (s.winner) return;
  if (r.phase === 'afterRoundEnd') { afterRoundEndDamage(ctx, 'ice'); return; }
  if (r.switcher && r.switcher.length) { // 還有替換招式要處理
    queueSwitcher(ctx, r.switcher, r); return;
  }
  s.phase = 'turn';
  if (r.advanceTurn) nextTurn(ctx, false);
}

// ───────── 回合中的操作 ─────────
function requireTurn(s, sd) {
  if (s.phase !== 'turn' || s.order[s.turnIdx] !== sd) fail('現在不是你的回合');
}

function doHold(ctx, it) {
  const s = ctx.s;
  requireTurn(s, it.side);
  ctx.log(`${active(s, it.side).name} 保留行動。`);
  nextTurn(ctx, true);
}

function doSwitch(ctx, it) {
  const s = ctx.s;
  requireTurn(s, it.side);
  const mon = active(s, it.side);
  if (mon.charging) fail('蓄力中不能替換');
  if (!switchOptions(s, it.side).includes(it.idx)) fail('現在不能換成這隻寶可夢');
  s.sides[it.side].switches++;
  ctx.log(`${s.sides[it.side].name || it.side} 收回了 ${mon.name}。`);
  enter(ctx, it.side, it.idx, true);
  nextTurn(ctx, false);
}

function doWill(ctx, it) {
  const s = ctx.s;
  const mon = active(s, it.side);
  if (!mon || mon.will < 1) fail('意志點不夠');
  if (it.kind === 'seize') {
    if (mon.willMode) fail(mon.willMode === 'push' ? '本輪已用過推動命運，不能再把握機會' : '本輪已經在把握機會');
    mon.will--; mon.willMode = 'seize';
    ctx.log(`${mon.name} 花費 1 點意志點：把握機會（本輪每次行動擲骰可重擲 1 顆失敗骰）。`);
  } else if (it.kind === 'pain') {
    if (mon.painIgnore >= 2) fail('已經完全忽略疼痛懲罰');
    mon.will--; mon.painIgnore++;
    ctx.log(`${mon.name} 花費 1 點意志點：挺過疼痛（本場忽略 ${mon.painIgnore} 級疼痛懲罰）。`);
  } else fail('未知的意志點用法');
}

function pushOk(mon, mods) {
  if (!mods || !mods.push) return false;
  if (mon.will < 1) fail('意志點不夠');
  if (mon.willMode === 'seize') fail('本輪已用過把握機會，不能再推動命運');
  return true;
}

function doMove(ctx, it) {
  const s = ctx.s;
  const sd = it.side;
  requireTurn(s, sd);
  const mon = active(s, sd);
  const opt = moveOptions(s, sd).find((o) => o.key === it.move);
  if (!opt) fail('沒有這個招式');
  if (!opt.ok) fail(opt.why);
  const info = opt.info;
  if (info.key === EVASION || info.key === CLASH) fail('閃避和對抗只能當作反應使用');
  const mods = it.mods || {};
  const foe = active(s, other(sd));
  const ch = { id: s.turnNo, actor: sd, info, mods, hits: [], reactions: [], awaiting: null, awaitAgainst: 'main', holdBack: false };

  if (opt.charging) {
    // 釋放蓄力招式：沿用蓄力時的命中結果
    mon.actions++;
    ch.hits.push({ net: mon.charging.net, ok: true, crit: mon.charging.crit });
    ctx.log(`${mon.name} 釋放了${info.name}！`, 'act');
    mon.charging = null;
  } else {
    if (!info.acc) fail('這個招式的命中骰需要手動處理，請用手動調整');
    const count = info.successive > 1 ? Math.max(1, Math.min(it.count || 1, info.successive, MAX_ACTIONS - mon.actions)) : 1;
    const pool = bestPool(s, mon, info.acc);
    let shieldPen = 0;
    if (info.shield) shieldPen = shieldPenalty(s, mon);
    const push = pushOk(mon, mods);
    for (let k = 0; k < count; k++) {
      const need = mon.actions + 1;
      const r = actionRoll(ctx, mon, pool, { lowAcc: info.lowAcc + mon.accPen + shieldPen, extraDice: mods.acc || 0, push: push && k === 0 });
      mon.actions++;
      const ok = r.net >= need;
      const crit = ok && r.net >= need + (info.highCrit ? 2 : 3);
      ch.hits.push({ net: r.net, need, ok, crit });
      ctx.log(`${mon.name} 使用${info.name}${count > 1 ? `（第 ${k + 1} 次）` : ''}：第 ${need} 個行動，命中 ${pool.n}${mods.acc ? (mods.acc > 0 ? '+' : '') + mods.acc : ''} 顆 ${r.text}（需要 ${need}）${ok ? (crit ? '，擊中要害！' : '，成功！') : '，失敗。'}`, 'act');
      if (!ok && mon.confusedRound && mon.st.confuse) hurt(ctx, mon, 1, '混亂中失敗');
    }
    mon.used.push(info.key);
    if (info.shield) { mon.lastShieldRound = s.round; }
    if (info.charge && ch.hits[0].ok) {
      mon.charging = { move: info.key, net: ch.hits[0].net, crit: ch.hits[0].crit };
      ctx.log(`${mon.name} 開始為${info.name}蓄力。下個回合釋放。`);
      return endAction(ctx);
    }
  }
  if (!ch.hits.some((h) => h.ok)) return endAction(ctx);
  // 著迷：攻擊心上人前要先過忠誠／洞察檢定
  if (mon.st.infat && FOE_TARGETS.has(info.target)) {
    const r = ctx.roll(Math.max(mon.def.loyalty || 0, stat(s, mon, 'ins')));
    ch.holdBack = succ(r) < 3;
    ctx.log(`${mon.name} 著迷判定：${showDice(r)} ${succ(r)} 成功，${ch.holdBack ? '不忍心全力攻擊（手下留情）' : '可以全力攻擊'}。`);
  }
  s.chain = ch;
  if (FOE_TARGETS.has(info.target) && foe && foe.hp > 0 && reactionWindow(s, other(sd), 'main')) {
    s.phase = 'react';
    return;
  }
  resolveChain(ctx);
}

function shieldPenalty(s, mon) {
  const consecutive = mon.lastShieldRound === s.round - 1;
  mon.shieldStreak = consecutive ? mon.shieldStreak + 1 : 0;
  return 2 * mon.shieldStreak;
}

function reactionWindow(s, sd, against) {
  s.chain.awaiting = sd; s.chain.awaitAgainst = against;
  if (reactionOptions(s, sd).length) return true;
  s.chain.awaiting = null;
  return false;
}

function doReact(ctx, it) {
  const s = ctx.s;
  const ch = s.chain;
  if (s.phase !== 'react' || !ch || ch.awaiting !== it.side) fail('現在不能反應');
  const sd = it.side;
  const mon = active(s, sd);
  if (it.kind === 'none') {
    ctx.log(`${mon.name} 沒有反應。`);
    ch.awaiting = null;
    return resolveChain(ctx);
  }
  const opt = reactionOptions(s, sd).find((o) => o.kind === it.kind && o.key === (it.move || (it.kind === 'evade' ? EVASION : undefined)));
  if (!opt) fail('不能用這個反應');
  const mods = it.mods || {};
  const info = moveInfo(DB, opt.key);
  const push = pushOk(mon, mods);
  let r, ok, need = opt.need, label;
  if (opt.kind === 'evade') {
    const pool = { attr: 'dex', n: stat(s, mon, 'dex') + (mon.def.skills.evasion || 0) + (mon.rank >= 7 ? 2 : 0) };
    r = actionRoll(ctx, mon, pool, { extraDice: mods.acc || 0, push });
    ok = r.net >= need; label = `閃避（靈巧＋閃避 ${pool.n} 顆）`;
  } else if (opt.kind === 'clash') {
    const a = info.cat === 'phys' ? 'str' : 'spe';
    const pool = { attr: a, n: stat(s, mon, a) + (mon.def.skills.clash || 0) + (mon.rank >= 7 ? 2 : 0) };
    r = actionRoll(ctx, mon, pool, { extraDice: mods.acc || 0, push });
    ok = r.net >= need; mon.used.push(info.key);
    label = `用${info.name}對抗（${a === 'str' ? '力量' : '特殊'}＋對抗 ${pool.n} 顆）`;
  } else {
    if (!info.acc) fail('這個招式的命中骰需要手動處理');
    const pool = bestPool(s, mon, info.acc);
    const shieldPen = info.shield ? shieldPenalty(s, mon) : 0;
    r = actionRoll(ctx, mon, pool, { lowAcc: info.lowAcc + mon.accPen + shieldPen, extraDice: mods.acc || 0, push });
    ok = r.net >= need; mon.used.push(info.key);
    if (info.shield) mon.lastShieldRound = s.round;
    label = `${info.reaction.late ? '後制' : '先制'}反應：${info.name}（第 ${need} 個行動，${pool.n} 顆）`;
  }
  mon.actions++;
  mon.reactedTurn = s.turnNo;
  const crit = ok && opt.kind === 'move' && r.net >= need + (info.highCrit ? 2 : 3);
  const rec = { side: sd, kind: opt.kind, info, net: r.net, ok, crit, against: ch.awaitAgainst, mods, holdBack: false };
  ch.reactions.push(rec);
  ctx.log(`${mon.name} ${label}：${r.text}（需要 ${need}）${ok ? '，成功！' : '，失敗。'}`, 'react');
  if (!ok && mon.confusedRound && mon.st.confuse) hurt(ctx, mon, 1, '混亂中失敗');
  if (ok && opt.kind === 'move' && mon.st.infat && FOE_TARGETS.has(info.target)) {
    const ir = ctx.roll(Math.max(mon.def.loyalty || 0, stat(s, mon, 'ins')));
    rec.holdBack = succ(ir) < 3;
    ctx.log(`${mon.name} 著迷判定：${showDice(ir)} ${succ(ir)} 成功，${rec.holdBack ? '手下留情' : '可以全力攻擊'}。`);
  }
  ch.awaiting = null;
  // 防守方的反應招式如果以攻擊方為目標，攻擊方可以反制一次
  if (ok && opt.kind === 'move' && sd !== ch.actor && FOE_TARGETS.has(info.target)) {
    if (reactionWindow(s, ch.actor, ch.reactions.length - 1)) return;
  }
  resolveChain(ctx);
}

// ───────── 結算 ─────────
function resolveChain(ctx) {
  const s = ctx.s;
  const ch = s.chain;
  s.phase = 'turn';
  // 結算順序：先制反應（數字大的先）→ 主要行動 → 後制反應（數字小的先）
  const items = [{ ref: 'main', side: ch.actor, info: ch.info, hits: ch.hits, mods: ch.mods, holdBack: ch.holdBack }];
  ch.reactions.forEach((r, i) => {
    if (r.kind === 'move' && r.ok) items.push({ ref: i, side: r.side, info: r.info, hits: [{ net: r.net, ok: true, crit: r.crit }], mods: r.mods, holdBack: r.holdBack, late: r.info.reaction.late, num: r.info.reaction.num });
  });
  const pres = items.filter((x) => x.ref !== 'main' && !x.late).sort((a, b) => b.num - a.num);
  const lates = items.filter((x) => x.ref !== 'main' && x.late).sort((a, b) => a.num - b.num);
  const order = [...pres, items[0], ...lates];
  const switcher = [];
  for (const it of order) {
    const user = active(s, it.side);
    if (!user || user.hp <= 0) { ctx.log(`${it.info.name}沒有發動（使用者已經倒下）。`); continue; }
    const defense = ch.reactions.filter((r) => r.against === it.ref && r.ok && r.kind !== 'move');
    const res = execute(ctx, it.side, it, defense);
    if (res && res.switcher) switcher.push(...res.switcher);
  }
  s.chain = null;
  endAction(ctx, switcher);
}

function endAction(ctx, switcher = []) {
  const s = ctx.s;
  s.phase = 'turn';
  if (checkFaint(ctx, { phase: 'turn', advanceTurn: true, mid: true, switcher })) return;
  if (switcher.length) { queueSwitcher(ctx, switcher, { phase: 'turn', advanceTurn: true }); return; }
  nextTurn(ctx, false);
}

function queueSwitcher(ctx, list, r) {
  const s = ctx.s;
  while (list.length) {
    const sw = list.shift();
    const side = s.sides[sw.side];
    const mon = active(s, sw.side);
    if (!mon || mon.idx !== sw.idx || mon.hp <= 0) continue; // 那隻已經倒下或不在場上
    const userSide = s.sides[sw.byUser ? sw.side : other(sw.side)];
    if (userSide.switcherUsed) { ctx.log('每位訓練家每輪只能發動一次替換招式效果。'); continue; }
    if (mon.st.block) { ctx.log(`${mon.name} 被阻擋，不能替換。`); continue; }
    if (!switchOptions(s, sw.side, 'forced').length) continue;
    userSide.switcherUsed = true;
    s.phase = 'switcherSwap'; s.await = { [sw.side]: true }; s.picks = {};
    s.resume = { ...r, switcher: list, forced: !sw.byUser };
    ctx.log(sw.byUser ? `${mon.name} 可以換下場。` : `${mon.name} 被逼得換下場！`);
    return;
  }
  s.phase = 'turn';
  if (r.advanceTurn) nextTurn(ctx, false);
}

// 執行一個招式的效果（主要行動或反應招式）
function execute(ctx, sd, it, defense) {
  const s = ctx.s;
  const info = it.info;
  const user = active(s, sd);
  const tsd = other(sd);
  const out = { switcher: [] };
  const toFoe = FOE_TARGETS.has(info.target);
  const tgt = toFoe ? active(s, tsd) : null;
  const evade = defense.find((r) => r.kind === 'evade');
  const clash = defense.find((r) => r.kind === 'clash');
  const shield = defense.find((r) => r.kind === 'shield');
  let defended = false;
  let anyHit = false;
  for (const [i, h] of it.hits.entries()) {
    if (!h.ok) continue;
    const first = !defended; defended = true; // 連續行動只有第一次命中可以被閃避或抵擋
    if (user.hp <= 0 || (toFoe && (!tgt || tgt.hp <= 0))) break;
    if (toFoe && first && evade) { ctx.log(`${tgt.name} 閃開了${info.name}！`); continue; }
    if (toFoe && first && clash) {
      const e1 = typeEff(clash.info.type, user.types), e2 = typeEff(info.type, tgt.types);
      const d1 = e1 === null ? 0 : Math.max(0, 1 + e1), d2 = e2 === null ? 0 : Math.max(0, 1 + e2);
      ctx.log(`${info.name}和${clash.info.name}對撞了！`);
      hurt(ctx, user, d1, '對抗'); hurt(ctx, tgt, d2, '對抗');
      continue;
    }
    anyHit = true;
    let dealt = 0;
    let immune = false;
    if (info.dmg && !info.dmg.manual && toFoe) {
      const r = damage(ctx, user, tgt, info, h, it.mods || {}, it.holdBack, first && shield ? shield.info.shield.reduce : 0);
      dealt = r.dealt; immune = r.immune;
      if (info.recoil && r.successes > 0) {
        const rr = ctx.roll(r.successes);
        hurt(ctx, user, succ(rr), `反作用傷害 ${showDice(rr)}`);
      }
    } else if (info.dmg && info.dmg.manual) {
      ctx.log(`${info.name}的傷害要依招式說明手動計算，請用「手動調整」扣 HP。`, 'warn');
    }
    // 額外效果
    const negated = toFoe && first && shield && shield.info.shield.negate;
    if (!immune && !it.holdBack) applyEffects(ctx, sd, info, negated, tgt);
    else if (it.holdBack) {
      applyEffects(ctx, sd, { ...info, effects: info.effects.filter((e) => e.who === 'self') }, false, tgt);
    }
    if (info.heal) heal(ctx, user, info.heal);
    if (info.switcherUser) out.switcher.push({ side: sd, byUser: true, idx: user.idx });
    if (info.switcherFoe && tgt && tgt.hp > 0) out.switcher.push({ side: tsd, byUser: false, idx: tgt.idx });
  }
  if (anyHit && info.recharge) { user.rechargeDebt++; ctx.log(`${user.name} 下一輪需要重新充能。`); }
  if (anyHit && info.dmg === null && !info.effects.length && !info.heal && !info.shield) {
    ctx.log(`效果：${info.text}`, 'note');
  } else if (anyHit && needsNote(info)) {
    ctx.log(`其他效果請依說明處理：${info.text}`, 'note');
  }
  return out;
}

function needsNote(info) {
  // 有程式沒處理的效果時，把招式說明印出來
  const en = DB.moves[info.key].en || '';
  return /\*|Rampage|Copy|Entry Hazard|Ongoing Damage|Blocks|Terrain|Barrier|Substitute|Out of Range|Vulnerable|If |Lethal/.test(en)
    && !/^Single Target\.( Lethal\.)?$/.test(en.trim());
}

function damage(ctx, user, tgt, info, hit, mods, holdBack, shieldReduce) {
  const s = ctx.s;
  const d = info.dmg;
  const eff = typeEff(info.type, tgt.types);
  if (eff === null) { ctx.log(`${tgt.name} 免疫${info.type}屬性的招式。`); return { dealt: 0, immune: true, successes: 0 }; }
  const atkAttr = d.attrs.reduce((b, x) => (attrVal(s, user, x) > attrVal(s, user, b) ? x : b), d.attrs[0]);
  const atk = attrVal(s, user, atkAttr);
  const stab = info.type && user.types.includes(info.type) ? 1 : 0;
  const crit = hit.crit && !holdBack ? 2 : 0;
  const w = s.weather && s.weather.kind;
  const wDice = (w === 'sun' && info.type === '火') || (w === 'rain' && info.type === '水') || (w === 'snow' && info.type === '冰') ? 1 : 0;
  const defK = info.cat === 'phys' ? 'def' : 'spdef';
  const def = info.ignoreDef ? 0 : stat(s, tgt, defK);
  const pool = Math.max(1, atk + d.power + stab + crit + wDice + (mods.dmg || 0) - def);
  const dice = ctx.roll(pool);
  const raw = succ(dice);
  const usesPain = !['vit', 'will'].includes(atkAttr);
  const after = Math.max(0, raw - (usesPain ? pain(user) : 0));
  let dmg = Math.max(1, after);
  let effTxt = '';
  if (eff > 0 && after >= 1) { dmg += eff; effTxt = eff >= 2 ? '效果無比絕佳！' : '效果絕佳！'; }
  if (eff < 0) { dmg += eff; effTxt = eff <= -2 ? '效果相當不好…' : '效果不好…'; }
  if ((w === 'sun' && info.type === '水') || (w === 'rain' && info.type === '火')) dmg -= 1;
  if (shieldReduce) dmg -= shieldReduce;
  dmg = Math.max(0, dmg);
  if (holdBack) dmg = Math.floor(dmg / 2);
  const parts = [`${STAT_ZH[atkAttr] || atkAttr}${atk}＋威力${d.power}`];
  if (stab) parts.push('屬性一致1');
  if (crit) parts.push('要害2');
  if (wDice) parts.push('天氣1');
  if (mods.dmg) parts.push(`調整${mods.dmg}`);
  if (def) parts.push(`−${STAT_ZH[defK]}${def}`);
  ctx.log(`傷害骰 ${parts.join('＋').replace('＋−', '−')} ＝ ${pool} 顆 ${showDice(dice)} → ${raw} 成功${usesPain && pain(user) ? `，疼痛 −${pain(user)}` : ''}${effTxt ? '，' + effTxt : ''}${shieldReduce ? `，護盾 −${shieldReduce}` : ''}${holdBack ? '，手下留情減半' : ''}`, 'dmg');
  hurt(ctx, tgt, dmg, info.name);
  // 對冰塊效果絕佳的招式會打破冰凍
  if (tgt.st.freeze && ['格鬥', '火', '岩石', '鋼'].includes(info.type)) { delete tgt.st.freeze; ctx.log(`${tgt.name} 身上的冰塊被打破了！`); }
  return { dealt: dmg, immune: false, successes: raw };
}

function hurt(ctx, mon, n, why) {
  if (n <= 0) { ctx.log(`${mon.name} 沒有受到傷害（${why}）。`); return; }
  const before = mon.hp;
  mon.hp = Math.max(0, mon.hp - n);
  ctx.log(`${mon.name} 受到 ${n} 點傷害（${why}）：HP ${before} → ${mon.hp}/${mon.maxHp}`, 'hp');
  if (mon.hp === 0) ctx.log(`${mon.name} 倒下了！`, 'big');
}

function heal(ctx, mon, kind) {
  let n = kind === 'complete' ? 5 : 3;
  if (kind !== 'complete') n = Math.min(n, 3 - mon.healed);
  n = Math.max(0, Math.min(n, mon.maxHp - mon.hp));
  if (n === 0) { ctx.log(`${mon.name} 不需要回復（HP 已滿或本輪已達回復上限），沒有花費意志點。`); return; }
  if (mon.will < 1) { ctx.log(`${mon.name} 沒有意志點，治療沒有效果。`); return; }
  mon.will--;
  mon.healed += n;
  mon.hp += n;
  ctx.log(`${mon.name} 花費 1 點意志點，回復了 ${n} 點 HP（${mon.hp}/${mon.maxHp}）。`, 'hp');
}

function applyEffects(ctx, sd, info, negated, tgt) {
  const s = ctx.s;
  const user = active(s, sd);
  for (const e of info.effects) {
    if (e.kind === 'weather') { setWeather(ctx, e.weather, e.rounds); continue; }
    const mon = e.who === 'self' ? user : tgt;
    if (!mon || mon.hp <= 0) continue;
    if (e.who !== 'self' && negated) { ctx.log(`護盾擋下了${info.name}的額外效果。`); continue; }
    if (e.chance) {
      let n = e.chance;
      if (e.status === 'freeze' && s.weather && ['snow', 'hail'].includes(s.weather.kind)) n++;
      const r = ctx.roll(n);
      const hit = r.includes(6);
      ctx.log(`機率骰 ${n} 顆 ${showDice(r)}${hit ? ' → 發動！' : ' → 沒有發動。'}`);
      if (!hit) continue;
    }
    if (e.kind === 'status') addStatus(ctx, mon, e.status, e.lvl, user);
    else if (e.kind === 'stat') {
      for (const k of e.stats) {
        const m = mon.mods[k];
        if (e.delta > 0) m.up = Math.max(m.up, e.delta); else m.down = Math.max(m.down, -e.delta);
      }
      ctx.log(`${mon.name} 的${e.stats.map((k) => STAT_ZH[k]).join('、')}${e.delta > 0 ? '提升' : '降低'}了 ${Math.abs(e.delta)}（招式效果不疊加，只取最大）。`);
    } else if (e.kind === 'accPen') {
      mon.accPen = Math.max(mon.accPen, e.n);
      ctx.log(`${mon.name} 之後的命中骰都要扣 ${mon.accPen} 個成功。`);
    }
  }
}

function setWeather(ctx, kind, rounds) {
  ctx.s.weather = { kind, rounds: rounds ?? null };
  ctx.log(`天氣變成了${WEATHER_ZH[kind]}${rounds ? `（${rounds} 輪）` : ''}。`, 'note');
}

const IMMUNE = { burn: ['火'], para: ['電'], poison: ['毒', '鋼'], badPoison: ['毒', '鋼'], freeze: ['冰'] };
export function addStatus(ctx, mon, st, lvl, source) {
  const s = ctx.s;
  if (IMMUNE[st] && mon.types.some((t) => IMMUNE[st].includes(t))) { ctx.log(`${mon.name} 的屬性免疫${STATUS_ZH[st]}。`); return; }
  const w = s.weather && s.weather.kind;
  if (st === 'freeze' && w === 'sun') { ctx.log('大晴天之下不會被冰凍。'); return; }
  if (st === 'burn' && w === 'rain' && (lvl || 1) >= 2 && !mon.st.burn) { ctx.log('下雨之下不會陷入 2、3 級灼傷。'); return; }
  const S = mon.st;
  if (st === 'burn') {
    const nl = S.burn ? Math.min(3, Math.max(S.burn.lvl + 1, lvl || 1)) : (lvl || 1);
    S.burn = { lvl: nl, prog: S.burn ? S.burn.prog : 0, rounds: S.burn && S.burn.lvl === nl ? S.burn.rounds : 0 };
    ctx.log(`${mon.name} 陷入${STATUS_ZH.burn} ${nl} 級！`, 'status');
  } else if (st === 'poison' || st === 'badPoison') {
    const bad = st === 'badPoison' || !!S.poison;
    S.poison = { bad, rounds: S.poison && S.poison.bad === bad ? S.poison.rounds : 0 };
    ctx.log(`${mon.name} 陷入${bad ? '劇毒' : '中毒'}！`, 'status');
  } else if (st === 'flinch') {
    if (mon.flinchRound) { ctx.log(`${mon.name} 本輪已經畏縮過了。`); return; }
    mon.flinchRound = true; S.flinch = true;
    ctx.log(`${mon.name} 畏縮了！`, 'status');
  } else if (st === 'sleep') {
    if (S.sleep) return;
    S.sleep = { prog: 0 };
    ctx.log(`${mon.name} 睡著了！`, 'status');
  } else if (st === 'freeze') {
    if (S.freeze) return;
    const snow = w === 'snow';
    S.freeze = { hp: snow ? 7 : 5, def: snow ? 3 : 2 };
    ctx.log(`${mon.name} 被冰凍了！`, 'status');
  } else if (st === 'infat') {
    S.infat = true;
    ctx.log(`${mon.name} 著迷了！`, 'status');
  } else {
    if (S[st]) return;
    S[st] = true;
    ctx.log(`${mon.name} 陷入${STATUS_ZH[st]}！`, 'status');
  }
}

function breakIce(ctx, sd, moveKey) {
  const s = ctx.s;
  const mon = active(s, sd);
  if (!mon.st.freeze) return;
  if (!moveKey) { ctx.log(`${mon.name} 沒有嘗試打破冰塊。`); return; }
  const info = moveInfo(DB, moveKey);
  if (['格鬥', '火', '岩石', '鋼'].includes(info.type)) { delete mon.st.freeze; ctx.log(`${mon.name} 用${info.name}一下就打破了冰塊！`); return; }
  if (!info.dmg || info.dmg.manual) { ctx.log(`${info.name}沒辦法打破冰塊。`); return; }
  const atkAttr = info.dmg.attrs.reduce((b, x) => (attrVal(s, mon, x) > attrVal(s, mon, b) ? x : b), info.dmg.attrs[0]);
  const stab = info.type && mon.types.includes(info.type) ? 1 : 0;
  const pool = Math.max(1, attrVal(s, mon, atkAttr) + info.dmg.power + stab - mon.st.freeze.def);
  const r = ctx.roll(pool);
  const n = Math.max(1, succ(r) - pain(mon));
  mon.st.freeze.hp -= n;
  if (mon.st.freeze.hp <= 0) { delete mon.st.freeze; ctx.log(`${mon.name} 用${info.name}打破了冰塊！（${showDice(r)}）`); }
  else ctx.log(`${mon.name} 用${info.name}打冰塊：${showDice(r)} ${n} 點，冰塊剩 ${mon.st.freeze.hp} HP。`);
}

// 倒下檢查。回傳 true 表示要先等玩家選下一隻
function checkFaint(ctx, resumeInfo) {
  const s = ctx.s;
  const need = {};
  for (const sd of SIDES) {
    const mon = active(s, sd);
    if (mon && mon.hp <= 0) {
      mon.st = {}; mon.charging = null;
      if (s.sides[sd].team.some((m) => m.hp > 0)) need[sd] = true;
    }
  }
  const lost = SIDES.filter((sd) => !s.sides[sd].team.some((m) => m.hp > 0));
  if (lost.length) {
    s.winner = lost.length === 2 ? 'draw' : other(lost[0]);
    ctx.log(s.winner === 'draw' ? '雙方同時全滅，平手！' : `${s.sides[s.winner].name || s.winner} 獲勝！`, 'big');
    s.phase = 'over';
    return true;
  }
  if (!Object.keys(need).length) return false;
  s.phase = 'faintSwap'; s.await = need; s.picks = {}; s.resume = resumeInfo;
  return true;
}

// ───────── 手動調整 ─────────
function doManual(ctx, it) {
  const s = ctx.s;
  const who = s.sides[it.side].name || it.side;
  const tsd = it.target;
  const mon = tsd ? active(s, tsd) : null;
  if (tsd && !mon) fail('場上沒有寶可夢');
  const tag = `【手動】${who}：`;
  switch (it.op) {
    case 'hp': {
      const v = Math.max(0, Math.min(mon.maxHp, it.value | 0));
      if (v === 0 && s.phase !== 'turn') fail('請在一般回合中（不是反應或換人時）再把 HP 調成 0');
      ctx.log(`${tag}${mon.name} 的 HP ${mon.hp} → ${v}`, 'manual');
      mon.hp = v;
      if (v === 0) ctx.log(`${mon.name} 倒下了！`, 'big');
      if (v === 0 && s.phase === 'turn') checkFaint(ctx, { phase: 'turn', advanceTurn: false, mid: true });
      break;
    }
    case 'will': mon.will = Math.max(0, Math.min(mon.maxWill, it.value | 0)); ctx.log(`${tag}${mon.name} 的意志點改為 ${mon.will}`, 'manual'); break;
    case 'status':
      if (it.on) addStatus(ctx, mon, it.status, it.lvl, null);
      else { delete mon.st[it.status === 'badPoison' ? 'poison' : it.status]; }
      ctx.log(`${tag}${it.on ? '加上' : '移除'} ${mon.name} 的${STATUS_ZH[it.status]}`, 'manual');
      if (it.status === 'disable' && it.on) mon.st.disable = { move: it.move, rounds: it.rounds ?? null };
      if (it.status === 'infat' && !it.on) delete mon.st.infat;
      break;
    case 'stat': {
      if (!STAT_KEYS.includes(it.stat)) fail('未知的能力值');
      const m = mon.mods[it.stat];
      for (const k of ['up', 'down', 'abil']) if (it[k] !== undefined) m[k] = it[k] | 0;
      ctx.log(`${tag}${mon.name} 的${STAT_ZH[it.stat]} 提升${m.up}／降低${m.down}／特性等${m.abil >= 0 ? '+' : ''}${m.abil} → 現在 ${stat(s, mon, it.stat)}`, 'manual');
      break;
    }
    case 'accPen': mon.accPen = Math.max(0, it.value | 0); ctx.log(`${tag}${mon.name} 的命中扣成功改為 ${mon.accPen}`, 'manual'); break;
    case 'actions': mon.actions = Math.max(0, Math.min(MAX_ACTIONS, it.value | 0)); ctx.log(`${tag}${mon.name} 本輪已用行動改為 ${mon.actions}`, 'manual'); break;
    case 'weather':
      if (it.weather) setWeather(ctx, it.weather, it.rounds ?? null); else { s.weather = null; ctx.log(`${tag}天氣清除`, 'manual'); }
      break;
    case 'note': ctx.log(`${tag}${String(it.text || '').slice(0, 200)}`, 'manual'); break;
    default: fail('未知的手動調整');
  }
}
