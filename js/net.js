// Firebase 連線：匿名登入、房間、事件紀錄
// 事件一律存成 JSON 字串，避免 Realtime Database 把空陣列、null 吃掉而讓重播結果不同。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, setPersistence, inMemoryPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, get, onValue, onChildAdded, runTransaction, serverTimestamp, off } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC5za4VacV_u0GWw5nKczafpShNpVgnpzs',
  authDomain: 'pokerole-battle.firebaseapp.com',
  databaseURL: 'https://pokerole-battle-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'pokerole-battle',
  storageBucket: 'pokerole-battle.firebasestorage.app',
  messagingSenderId: '1021588929953',
  appId: '1:1021588929953:web:92999662e3489896f91fe0',
};

let db = null;
export let uid = null;

export async function init({ guest = false } = {}) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  // guest=true：這個分頁用一次性身分（同一台電腦開兩個分頁測試時用）
  await setPersistence(auth, guest ? inMemoryPersistence : browserLocalPersistence);
  const cred = await signInAnonymously(auth);
  uid = cred.user.uid;
  db = getDatabase(app);
  return uid;
}

const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const evKey = (n) => 'e' + String(n).padStart(6, '0');

export async function createRoom(settings, name, ver) {
  for (let t = 0; t < 5; t++) {
    const code = newCode();
    const r = await runTransaction(ref(db, `rooms/${code}`), (cur) => {
      if (cur !== null) return undefined;
      return { created: serverTimestamp(), ver, settings: JSON.stringify(settings), players: { A: { uid, name } } };
    });
    if (r.committed) return code;
  }
  throw new Error('建立房間失敗，請再試一次');
}

// 回傳我在這個房間的位置（A 或 B）
export async function joinRoom(code, name) {
  code = code.trim().toUpperCase();
  const snap = await get(ref(db, `rooms/${code}/created`));
  if (!snap.exists()) throw new Error('找不到這個房間');
  let side = null;
  const r = await runTransaction(ref(db, `rooms/${code}/players`), (p) => {
    p = p || {};
    if (p.A && p.A.uid === uid) { side = 'A'; return p; }
    if (p.B && p.B.uid === uid) { side = 'B'; return p; }
    if (!p.B) { side = 'B'; p.B = { uid, name }; return p; }
    side = null; return undefined;
  });
  if (!r.committed || !side) throw new Error('這個房間已經滿了');
  return side;
}

export async function roomInfo(code) {
  const snap = await get(ref(db, `rooms/${code}`));
  if (!snap.exists()) return null;
  const v = snap.val();
  return { ver: v.ver, settings: JSON.parse(v.settings), players: v.players || {} };
}

// 監聽：players 變動、事件逐筆送達（依序）
export function watch(code, { onPlayers, onEvent }) {
  const pRef = ref(db, `rooms/${code}/players`);
  const eRef = ref(db, `rooms/${code}/events`);
  onValue(pRef, (s) => onPlayers(s.val() || {}));
  onChildAdded(eRef, (s) => onEvent(s.key, JSON.parse(s.val())));
  return () => { off(pRef); off(eRef); };
}

// 一次讀取整個房間（用來判斷「我的房間」現在輪到誰）；房間不存在時回傳 null
export async function roomSnapshot(code) {
  const snap = await get(ref(db, `rooms/${code}`));
  if (!snap.exists()) return null;
  const v = snap.val();
  const events = Object.keys(v.events || {}).sort().map((k) => JSON.parse(v.events[k]));
  return { ver: v.ver, settings: JSON.parse(v.settings), players: v.players || {}, events };
}

// 寫入第 n 筆事件；如果對方剛好先寫了同一筆，回傳 false
export async function pushEvent(code, n, ev) {
  const r = await runTransaction(ref(db, `rooms/${code}/events/${evKey(n)}`), (cur) => (cur === null ? JSON.stringify(ev) : undefined));
  return r.committed;
}
