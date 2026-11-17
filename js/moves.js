// 招式判讀：把招式資料（中文欄位＋英文效果原文）轉成引擎能用的結構。
// 讀不懂的效果不會猜，留給玩家用「手動調整」處理。

export const ATTR_ZH = { 力量: 'str', 靈巧: 'dex', 體魄: 'vit', 特殊: 'spe', 洞察: 'ins',
  強壯: 'tough', 帥氣: 'cool', 美麗: 'beauty', 可愛: 'cute', 聰明: 'clever', 意志: 'will' };
export const SKILL_ZH = { 鬥毆: 'brawl', 導引: 'channel', 對抗: 'clash', 閃避: 'evasion', 投擲: 'throw',
  警覺: 'alert', 運動: 'athletic', 自然: 'nature', 隱匿: 'stealth',
  魅惑: 'allure', 共感: 'empathy', 禮儀: 'etiquette', 威嚇: 'intimidate', 表演: 'perform' };
export const SOCIAL = ['tough', 'cool', 'beauty', 'cute', 'clever'];
export const STAT_EN = { strength: 'str', dexterity: 'dex', vitality: 'vit', special: 'spe', insight: 'ins',
  defense: 'def', 'sp. def': 'spdef', 'sp.def': 'spdef', 'sp. defense': 'spdef', 'special defense': 'spdef' };

// 招式資料裡的閃避、對抗兩個無屬性戰技
export const EVASION = 'Evasion';
export const CLASH = 'Clash';
export const STRUGGLE = 'Struggle';

const cache = new Map();

function parsePool(s) {
  // 「靈巧/力量 + 運動/鬥毆」→ { attrs:['dex','str'], skills:['athletic','brawl'] }
  if (!s) return null;
  s = s.replace(/\s+/g, '');
  if (/[*＊]/.test(s)) return null;
  const [l, r, extra] = s.split('+');
  if (extra !== undefined) return null;
  const attrs = l.split('/').map((x) => ATTR_ZH[x]);
  if (!attrs.length || attrs.some((x) => !x)) return null;
  let skills = [];
  if (r !== undefined) {
    skills = r.split('/').map((x) => SKILL_ZH[x]);
    if (skills.some((x) => !x)) return null;
  }
  return { attrs, skills };
}

function parseDamage(d, p) {
  if (!d || /^[-—]$/.test(d.trim())) return null;            // 沒有傷害
  const m = d.replace(/\s+/g, '').match(/^([^+]+)\+(\d+)(\*+)?$/);
  if (!m) return { manual: true };
  const attrs = m[1].split('/').map((x) => ATTR_ZH[x]);
  if (attrs.some((x) => !x)) return { manual: true };
  return { attrs, power: parseInt(p ?? m[2], 10) || parseInt(m[2], 10), star: !!m[3] };
}

const WHO = (w) => (/user/i.test(w) ? 'self' : 'foe');
const STAT_LIST = String.raw`((?:Sp\.\s?Def(?:ense)?|Special Defense|Strength|Dexterity|Vitality|Special|Insight|Defense)(?:\s*(?:,|and|,\s*and)\s*(?:Sp\.\s?Def(?:ense)?|Special Defense|Strength|Dexterity|Vitality|Special|Insight|Defense))*)`;

function statsOf(list) {
  return list.split(/\s*(?:,|\band\b)\s*/).map((x) => STAT_EN[x.trim().toLowerCase().replace(/\s+/g, ' ')]).filter(Boolean);
}

export function parseEffects(en) {
  const effects = [];
  if (!en) return effects;
  const text = ' ' + en.replace(/\s+/g, ' ');
  const chance = (c) => (c ? parseInt(c, 10) : 0);
  let m;
  // 異常狀態
  const reS = /(?:^|[.]\s+)(?:Roll (\d+) Chance \w+ to )?(Badly Poison|Poison|Paralyze|Confuse|Flinch|Freeze|Infatuate) (the Target|the Foe|those affected|those Affected|the User|all Foes|the Targets)/g;
  while ((m = reS.exec(text))) {
    const st = { 'Badly Poison': 'badPoison', Poison: 'poison', Paralyze: 'para', Confuse: 'confuse', Flinch: 'flinch', Freeze: 'freeze', Infatuate: 'infat' }[m[2]];
    effects.push({ kind: 'status', status: st, chance: chance(m[1]), who: WHO(m[3]) });
  }
  const reB = /(?:^|[.]\s+)(?:Roll (\d+) Chance \w+ to )?[Ii]nflict (\d)\w* Degree Burn on (the Target|those affected|those Affected|the Foe|the User)/g;
  while ((m = reB.exec(text))) effects.push({ kind: 'status', status: 'burn', lvl: +m[2], chance: chance(m[1]), who: WHO(m[3]) });
  const reSl = /(?:^|[.]\s+)(?:Roll (\d+) Chance \w+ to )?Put (the Target|those affected|the Foe|the User) to [Ss]leep/g;
  while ((m = reSl.exec(text))) effects.push({ kind: 'status', status: 'sleep', chance: chance(m[1]), who: WHO(m[2]) });
  // 能力升降
  const reA = new RegExp(String.raw`(?:^|[.]\s+)(?:Roll (\d+) Chance \w+ to )?(Increase|Reduce|Raise|Lower)(?: by (\d+))?(?: the)? (User|Target|Foe)(?:'s|’s|s')? ${STAT_LIST}(?: by (\d+))?`, 'g');
  while ((m = reA.exec(text))) {
    const n = parseInt(m[3] || m[6], 10);
    if (!n) continue;
    const sign = /Increase|Raise/.test(m[2]) ? 1 : -1;
    effects.push({ kind: 'stat', stats: statsOf(m[5]), delta: sign * n, chance: chance(m[1]), who: WHO(m[4]) });
  }
  const reB2 = new RegExp(String.raw`(?:^|[.]\s+)(?:Roll (\d+) Chance \w+ to )?(Increase|Reduce|Raise|Lower) by (\d+) the ${STAT_LIST} of (those affected|those Affected|the Target|the User|the Foe|User and Allies)`, 'g');
  while ((m = reB2.exec(text))) {
    const sign = /Increase|Raise/.test(m[2]) ? 1 : -1;
    effects.push({ kind: 'stat', stats: statsOf(m[4]), delta: sign * +m[3], chance: chance(m[1]), who: WHO(m[5]) });
  }
  const reL = /(?:^|[.]\s+)Target is now In Love with the User/g;
  while ((m = reL.exec(text))) effects.push({ kind: 'status', status: 'infat', chance: 0, who: 'foe' });
  const reAcc = /Reduce (\d+) success(?:es)? to all the Accuracy Rolls of the Target/g;
  while ((m = reAcc.exec(text))) effects.push({ kind: 'accPen', n: +m[1], chance: 0, who: 'foe' });
  // 天氣
  const reW = /Activate (?:the Effects? of )?(Sunny|Rain|Sandstorm|Hail|Snowy|Snow)\w* Weather/i;
  if ((m = text.match(reW))) {
    const w = { sunny: 'sun', rain: 'rain', sandstorm: 'sand', hail: 'hail', snowy: 'snow', snow: 'snow' }[m[1].toLowerCase()];
    const dur = text.match(/Duration (\d+) Rounds?/i);
    effects.push({ kind: 'weather', weather: w, rounds: dur ? +dur[1] : null });
  }
  return effects;
}

function parseTarget(en) {
  if (/Target Self/i.test(en)) return 'self';
  if (/Target One Ally/i.test(en)) return 'ally';
  if (/Target User and Allies/i.test(en)) return 'self';
  if (/Target All Foes|Target all foes/i.test(en)) return 'allFoes';
  if (/Target Random Foe/i.test(en)) return 'randomFoe';
  if (/Target Foe'?s Side/i.test(en)) return 'foeField';
  if (/Target (User'?s|Your|Ally) Side/i.test(en)) return 'ownField';
  if (/Target Battlefield/i.test(en)) return 'field';
  if (/Area Move/i.test(en)) return 'area';
  return 'foe';
}

export const FOE_TARGETS = new Set(['foe', 'allFoes', 'randomFoe', 'area']);

export function moveInfo(db, key) {
  if (cache.has(key)) return cache.get(key);
  const m = db.moves[key];
  if (!m) throw new Error('沒有這個招式：' + key);
  const en = m.en || '';
  const cat = { 物理: 'phys', 特殊: 'spec' }[m.c] || 'status';
  const acc = parsePool(m.a);
  const dmg = cat === 'status' ? null : (/Fixed Damage|定傷/.test(en + m.d) ? { manual: true } : parseDamage(m.d, m.p));
  const reac = en.match(/(Late )?Reaction (\d+)/);
  const shield = /Shield Move/i.test(en);
  const red = en.match(/Reduce (\d+) Damage (?:This Pokémon|the User|this Pokémon)/i);
  const info = {
    key, name: m.z, type: m.t === '無' || !m.t ? null : m.t, cat, acc, dmg,
    social: !!acc && acc.attrs.some((a) => ['tough', 'cool', 'beauty', 'cute', 'clever'].includes(a)),
    target: parseTarget(en),
    reaction: reac ? { late: !!reac[1], num: +reac[2] } : null,
    lowAcc: +(en.match(/Low Accuracy (\d+)/i)?.[1] || 0),
    highCrit: /High Critical/i.test(en),
    neverMiss: /Never Miss/i.test(en),
    ignoreDef: /Ignore Defenses/i.test(en),
    charge: /Charge Move/i.test(en),
    recharge: /Must Recharge/i.test(en),
    recoil: /\bRecoil\b/i.test(en),
    successive: /Successive Actions/i.test(en) ? 5 : /Triple Action/i.test(en) ? 3 : /Double Action/i.test(en) ? 2 : 1,
    switcherUser: /Switcher Move for the User/i.test(en),
    switcherFoe: /Switcher Move for the Foe/i.test(en),
    rampage: /\bRampage\b/i.test(en),
    shield: shield ? { reduce: red ? +red[1] : 0, negate: /Negate the Added Effects/i.test(en) } : null,
    heal: /Complete Heal/i.test(en) ? 'complete' : /Basic Heal/i.test(en) ? 'basic' : null,
    maneuver: key === EVASION || key === CLASH || key === STRUGGLE || m.t === '無',
    effects: parseEffects(en),
    text: m.e,
  };
  if (key === STRUGGLE) info.type = null;
  cache.set(key, info);
  return info;
}

// 不能被對抗、也不能拿來對抗的招式
export function clashable(info) {
  return (info.cat === 'phys' || info.cat === 'spec') && !info.ignoreDef && !(info.dmg && info.dmg.manual)
    && !info.social && !info.maneuver && info.target !== 'field' && info.target !== 'foeField';
}
export function evadable(info) {
  return !info.social && !info.neverMiss && info.target !== 'field' && info.target !== 'foeField' && info.target !== 'ownField';
}
