// 執行：node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as E from '../js/engine.js';
import { moveInfo } from '../js/moves.js';

const db = JSON.parse(fs.readFileSync(new URL('../data/db.json', import.meta.url), 'utf8'));
E.setDB(db);
const dexIdx = (n) => db.dex.findIndex((d) => d.n === n);

function mk(n, moves, attr = {}, skills = {}, extra = {}) {
  return {
    dex: dexIdx(n), nick: '', rank: 3,
    attr: { str: 2, dex: 2, vit: 2, spe: 2, ins: 2, ...attr },
    social: { tough: 1, cool: 1, beauty: 1, cute: 1, clever: 1 },
    skills: { brawl: 2, channel: 2, clash: 2, evasion: 2, alert: 1, athletic: 1, ...skills },
    loyalty: 2, happiness: 2, ability: '', item: '', moves, ...extra,
  };
}
const SIX = (n = 300) => Array(n).fill(6);
const ONE = (n = 300) => Array(n).fill(1);
const run = (s, intent, tape) => E.applyEvent(s, { intent, tape });

// A 先攻：A 先攻骰 6、B 先攻骰 1
function start(teamA, teamB, settings) {
  let s = E.newGame({ teamSize: 6, ...settings });
  s = run(s, { type: 'team', side: 'A', team: teamA }, []);
  s = run(s, { type: 'team', side: 'B', team: teamB }, []);
  s = run(s, { type: 'lead', side: 'A', idx: 0 }, []);
  s = run(s, { type: 'lead', side: 'B', idx: 0 }, [6, 1]);
  return s;
}

test('先攻與輪流', () => {
  const s = start([mk('Pikachu', ['Thunder Shock'])], [mk('Eevee', ['Tackle'])]);
  assert.equal(s.round, 1);
  assert.deepEqual(s.order, ['A', 'B']);
  assert.deepEqual(E.expecting(s), { phase: 'turn', sides: ['A'] });
});

test('多重行動難度與戰鬥輪結束', () => {
  let s = start([mk('Pikachu', ['Thunder Shock', 'Quick Attack', 'Growl'])], [mk('Eevee', ['Tackle'], { vit: 5 })]);
  // A 第 1 個行動：4 顆命中骰各擲 4 → 4 成功 ≥ 1
  s = run(s, { type: 'move', side: 'A', move: 'Growl' }, [4, 4, 4, 4, 6]);
  assert.equal(E.active(s, 'A').actions, 1);
  s = run(s, { type: 'hold', side: 'B' }, []);
  // A 第 2 個行動：需要 2 成功，只擲出 1 → 失敗
  s = run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, [6, 1, 1, 1]);
  assert.equal(E.active(s, 'A').actions, 2);
  assert.match(s.log.at(-1).text, /失敗/);
  s = run(s, { type: 'hold', side: 'B' }, []);
  s = run(s, { type: 'hold', side: 'A' }, []);
  // 雙方連續保留 → 進入第 2 輪（B 有閃避反應可選時不影響；這裡沒有被攻擊）
  assert.equal(s.round, 2);
  assert.equal(E.active(s, 'A').actions, 0);
});

test('同一招每輪只能用一次', () => {
  let s = start([mk('Pikachu', ['Thunder Shock'])], [mk('Eevee', ['Tackle'])]);
  s = run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, ONE());
  s = run(s, { type: 'hold', side: 'B' }, []);
  assert.throws(() => run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, ONE()), /本輪已使用/);
});

test('傷害公式：屬性一致、防禦、最少 1 點', () => {
  let s = start([mk('Pikachu', ['Thunder Shock'], { spe: 3 })], [mk('Eevee', ['Tackle'], { vit: 2 })]);
  // 命中 4 顆全 6 → 4 成功，比需要多 3 → 擊中要害；B 不反應
  s = run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, [6, 6, 6, 6]);
  assert.equal(s.phase, 'react');
  // 傷害骰池：特殊3＋威力? ＋屬性一致1＋要害2−特防2
  const pw = moveInfo(db, 'Thunder Shock').dmg.power;
  const pool = 3 + pw + 1 + 2 - 2;
  const hp0 = E.active(s, 'B').hp;
  s = run(s, { type: 'react', side: 'B', kind: 'none' }, [...Array(pool).fill(1), 1, 1, 1]);
  assert.equal(E.active(s, 'B').hp, hp0 - 1, '0 成功仍造成 1 點');
});

test('閃避成功：不受傷害、不吃多重行動難度、消耗行動', () => {
  let s = start([mk('Pikachu', ['Thunder Shock'])], [mk('Eevee', ['Tackle'], {}, { evasion: 2 })]);
  s = run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, [6, 6, 1, 1]); // 2 成功
  const hp0 = E.active(s, 'B').hp;
  const opts = E.reactionOptions(s, 'B');
  assert.ok(opts.some((o) => o.kind === 'evade'));
  s = run(s, { type: 'react', side: 'B', kind: 'evade' }, [6, 6, 1, 1]); // 2 ≥ 2
  assert.equal(E.active(s, 'B').hp, hp0);
  assert.equal(E.active(s, 'B').actions, 1);
  assert.deepEqual(E.expecting(s).sides, ['B']); // 輪到 B
});

test('反應連鎖：先制反應 vs 更大數字的先制反應，結算順序正確', () => {
  // A 用撞擊攻擊；B 以電光一閃（先制 1）反應；A 以神速（先制 2）反制
  let s = start([mk('Eevee', ['Tackle', 'Extreme Speed'])], [mk('Pikachu', ['Quick Attack'])]);
  s = run(s, { type: 'move', side: 'A', move: 'Tackle' }, SIX(4));
  assert.equal(s.phase, 'react');
  s = run(s, { type: 'react', side: 'B', kind: 'move', move: 'Quick Attack' }, SIX(4));
  assert.equal(s.phase, 'react');
  assert.equal(s.chain.awaiting, 'A');
  const opts = E.reactionOptions(s, 'A').map((o) => o.key);
  assert.ok(opts.includes('Extreme Speed'));
  s = run(s, { type: 'react', side: 'A', kind: 'move', move: 'Extreme Speed' }, [6, 6, 6, 6, ...ONE()]);
  const names = s.log.filter((l) => l.kind === 'dmg' || l.kind === 'hp').map((l) => l.text);
  // 先結算神速（打 B），再電光一閃（打 A），最後撞擊（打 B）
  const order = names.filter((t) => /受到/.test(t)).map((t) => t.match(/（(.+?)）/)[1]);
  assert.deepEqual(order, ['神速', '電光一閃', '撞擊']);
  assert.equal(E.active(s, 'A').actions, 2);
  assert.equal(E.active(s, 'B').actions, 1);
});

test('先制反應不能回應後制反應；後制可以回應先制', () => {
  let s = start([mk('Eevee', ['Tackle', 'Quick Attack', 'Avalanche'])], [mk('Pikachu', ['Quick Attack'])]);
  s = run(s, { type: 'move', side: 'A', move: 'Tackle' }, SIX(4));
  s = run(s, { type: 'react', side: 'B', kind: 'move', move: 'Quick Attack' }, SIX(4));
  const keys = E.reactionOptions(s, 'A').map((o) => o.key);
  assert.ok(keys.includes('Avalanche'), '後制可以回應先制');
  assert.ok(!E.reactionOptions(s, 'A').some((o) => o.kind === 'move' && o.key === 'Quick Attack'), '同數字的先制不行');
});

test('每個回合只能反應一次，反制後防守方不能再反應', () => {
  let s = start([mk('Eevee', ['Tackle', 'Extreme Speed'])], [mk('Pikachu', ['Quick Attack'])]);
  s = run(s, { type: 'move', side: 'A', move: 'Tackle' }, SIX(4));
  s = run(s, { type: 'react', side: 'B', kind: 'move', move: 'Quick Attack' }, SIX(4));
  s = run(s, { type: 'react', side: 'A', kind: 'move', move: 'Extreme Speed' }, ONE());
  assert.equal(s.phase, 'turn');
  assert.equal(s.chain, null);
});

test('倒下 → 換下一隻，中途上場的本輪不能行動', () => {
  let s = start([mk('Pikachu', ['Thunder Shock'], { spe: 5 })], [mk('Eevee', ['Tackle'], { vit: 1 }), mk('Bulbasaur', ['Tackle'])]);
  E.active(s, 'B').hp = 1;
  s = run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, SIX());
  if (s.phase === 'react') s = run(s, { type: 'react', side: 'B', kind: 'none' }, SIX());
  assert.equal(s.phase, 'faintSwap');
  s = run(s, { type: 'swap', side: 'B', idx: 1 }, []);
  assert.equal(E.active(s, 'B').name, '妙蛙種子');
  // 輪到 B 但牠剛上場 → 自動跳過，又輪到 A
  assert.deepEqual(E.expecting(s).sides, ['A']);
  assert.equal(E.active(s, 'B').actions, 0);
});

test('全滅判輸', () => {
  let s = start([mk('Pikachu', ['Thunder Shock'], { spe: 5 })], [mk('Eevee', ['Tackle'])]);
  E.active(s, 'B').hp = 1;
  s = run(s, { type: 'move', side: 'A', move: 'Thunder Shock' }, SIX());
  if (s.phase === 'react') s = run(s, { type: 'react', side: 'B', kind: 'none' }, SIX());
  assert.equal(s.winner, 'A');
});

test('自己回合替換：免費、每輪最多 2 次，新上場的本輪不能行動', () => {
  let s = start([mk('Pikachu', ['Thunder Shock']), mk('Eevee', ['Tackle']), mk('Bulbasaur', ['Tackle'])], [mk('Eevee', ['Tackle'])]);
  s = run(s, { type: 'switch', side: 'A', idx: 1 }, []);
  assert.equal(E.active(s, 'A').name, '伊布');
  assert.deepEqual(E.expecting(s).sides, ['B']);
  s = run(s, { type: 'hold', side: 'B' }, []);
  // A 剛上場不能行動 → 自動跳過；連同 B 保留 → 戰鬥輪結束 → 換人視窗
  assert.equal(s.phase, 'endSwap');
});

test('戰鬥輪結束：中毒 2、劇毒逐輪 +1、三級灼傷逐輪 +1', () => {
  let s = start([mk('Eevee', ['Tackle'], { vit: 10 }, {}, {})], [mk('Snorlax', ['Tackle'], { vit: 10 })]);
  const a = E.active(s, 'A'), b = E.active(s, 'B');
  a.st.poison = { bad: true, rounds: 0 };
  b.st.burn = { lvl: 3, prog: 0, rounds: 0 };
  const ha = a.hp, hb = b.hp;
  s = run(s, { type: 'hold', side: 'A' }, ONE());
  s = run(s, { type: 'hold', side: 'B' }, ONE()); // B 的撲滅檢定全失敗
  assert.equal(E.active(s, 'A').hp, ha - 2);
  assert.equal(E.active(s, 'B').hp, hb - 3);
  if (s.phase === 'endSwap') s = run(s, { type: 'swap', side: 'A', idx: null }, []);
  // 第 2 輪
  s = run(s, { type: 'hold', side: 'A' }, ONE());
  s = run(s, { type: 'hold', side: 'B' }, ONE());
  assert.equal(E.active(s, 'A').hp, ha - 2 - 3);
  assert.equal(E.active(s, 'B').hp, hb - 3 - 4);
});

test('疼痛懲罰門檻：上限 7 時 HP ≤ 3 扣 1、HP 1 扣 2', () => {
  const m = { hp: 4, maxHp: 7, painIgnore: 0 };
  assert.equal(E.pain(m), 0);
  m.hp = 3; assert.equal(E.pain(m), 1);
  m.hp = 1; assert.equal(E.pain(m), 2);
  m.painIgnore = 1; assert.equal(E.pain(m), 1);
});

test('睡眠：回合開始自動擲清醒判定，算一個行動', () => {
  let s = start([mk('Eevee', ['Tackle'])], [mk('Pikachu', ['Thunder Shock'])]);
  E.active(s, 'B').st.sleep = { prog: 0 };
  s = run(s, { type: 'hold', side: 'A' }, ONE());
  assert.equal(E.active(s, 'B').actions, 1);
  assert.deepEqual(E.expecting(s).sides, ['A']);
});

test('招式效果：機率骰麻痺、招式提升不疊加', () => {
  let s = start([mk('Pikachu', ['Thunderbolt', 'Swords Dance'], { spe: 4 }, { channel: 3, perform: 3 })], [mk('Snorlax', ['Tackle'], { vit: 10, ins: 10 })]);
  s = run(s, { type: 'move', side: 'A', move: 'Thunderbolt' }, SIX(7));
  s = run(s, { type: 'react', side: 'B', kind: 'none' }, SIX());
  assert.ok(E.active(s, 'B').st.para);
  s = run(s, { type: 'hold', side: 'B' }, []);
  s = run(s, { type: 'move', side: 'A', move: 'Swords Dance' }, SIX());
  assert.equal(E.active(s, 'A').mods.str.up, 2);
});

test('事件重播：隨機對戰 200 場，重播結果與現場一致、數值不越界', () => {
  const pool = ['Pikachu', 'Eevee', 'Bulbasaur', 'Charmander', 'Squirtle', 'Gengar', 'Snorlax', 'Lucario'];
  for (let g = 0; g < 200; g++) {
    const team = () => Array.from({ length: 3 }, () => {
      const n = pool[Math.floor(Math.random() * pool.length)];
      const d = db.dex[dexIdx(n)];
      const mv = d.mv.map((x) => x[0]).filter((k) => db.moves[k]).sort(() => Math.random() - 0.5).slice(0, 6);
      return mk(n, mv, { str: 3, dex: 3, vit: 2, spe: 3, ins: 2 }, { brawl: 2, channel: 2, clash: 1, evasion: 2, alert: 1, athletic: 1 });
    });
    let s = E.newGame({ teamSize: 3 });
    const events = [];
    const step = (intent) => { const r = E.act(s, intent); s = r.state; events.push(r.event); };
    step({ type: 'team', side: 'A', team: team() });
    step({ type: 'team', side: 'B', team: team() });
    let n = 0;
    while (!s.winner && n++ < 400) {
      const ex = E.expecting(s);
      const sd = ex.sides[0];
      const r = Math.random();
      try {
        if (['lead', 'faintSwap', 'endSwap', 'switcherSwap'].includes(ex.phase)) {
          const alive = s.sides[sd].team.map((m, i) => i).filter((i) => s.sides[sd].team[i].hp > 0 && (ex.phase === 'lead' || i !== s.sides[sd].active));
          const idx = ex.phase === 'endSwap' && r < 0.7 ? null : alive[Math.floor(Math.random() * alive.length)];
          step({ type: 'swap', side: sd, idx, ...(ex.phase === 'lead' ? { type: 'lead' } : {}) });
        } else if (ex.phase === 'ice') {
          step({ type: 'ice', side: sd, move: null });
        } else if (ex.phase === 'react') {
          const o = E.reactionOptions(s, sd);
          const c = r < 0.5 || !o.length ? { kind: 'none' } : o[Math.floor(Math.random() * o.length)];
          step({ type: 'react', side: sd, kind: c.kind, move: c.key });
        } else if (ex.phase === 'turn') {
          const mo = E.moveOptions(s, sd).filter((o) => o.ok && (o.info.acc || o.charging) && o.key !== 'Evasion' && o.key !== 'Clash');
          const sw = E.switchOptions(s, sd);
          if (r < 0.15 || !mo.length) step({ type: 'hold', side: sd });
          else if (r < 0.2 && sw.length) step({ type: 'switch', side: sd, idx: sw[0] });
          else if (r < 0.23) step({ type: 'will', side: sd, kind: 'seize' });
          else { const o = mo[Math.floor(Math.random() * mo.length)]; step({ type: 'move', side: sd, move: o.key, count: 2, mods: { push: Math.random() < 0.1 } }); }
        } else break;
      } catch (e) {
        if (!e.rule) throw e; // 規則上不允許的操作可以忽略，其他錯誤要報
      }
      for (const sd2 of E.SIDES) for (const m of s.sides[sd2].team || []) {
        assert.ok(m.hp >= 0 && m.hp <= m.maxHp, 'HP 越界');
        assert.ok(m.actions >= 0 && m.actions <= 5, '行動數越界 ' + m.actions);
        assert.ok(m.will >= 0, '意志點變負');
      }
    }
    const re = E.replay({ teamSize: 3 }, events);
    assert.deepEqual(JSON.stringify(re), JSON.stringify(s), '重播不一致');
  }
});
