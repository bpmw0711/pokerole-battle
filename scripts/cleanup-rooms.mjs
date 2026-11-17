// 清理 Firebase Realtime Database 裡太久沒人用的對戰房間。
// 一個房間的「最後使用時間」＝ rooms/<房號>/active（每次出招、進房都會更新），沒有的話用 created。
// 超過 IDLE_DAYS（預設 7）天沒人用就整間刪除。沒有時間欄位的殘留資料也一併刪除。
// 環境變數：FIREBASE_SERVICE_ACCOUNT（服務帳戶金鑰 JSON）、DRY_RUN=true（只列出，不刪）、IDLE_DAYS。
import { pathToFileURL } from 'node:url';

export const DB_URL = 'https://pokerole-battle-default-rtdb.asia-southeast1.firebasedatabase.app';

export async function cleanup({ fetchFn = fetch, token, days = 7, dry = true, now = Date.now(), log = console.log }) {
  const url = (path, extra = '') => `${DB_URL}/${path}.json?access_token=${token}${extra}`;
  const getJson = async (path, extra) => {
    const r = await fetchFn(url(path, extra));
    if (!r.ok) throw new Error(`讀取 ${path} 失敗：HTTP ${r.status}`);
    return r.json();
  };
  const codes = Object.keys((await getJson('rooms', '&shallow=true')) || {});
  log(`共有 ${codes.length} 個房間，清理超過 ${days} 天沒人用的${dry ? '（試跑，不會真的刪除）' : ''}`);
  let removed = 0, kept = 0;
  for (let i = 0; i < codes.length; i += 10) {
    await Promise.all(codes.slice(i, i + 10).map(async (code) => {
      const [active, created] = await Promise.all([getJson(`rooms/${code}/active`), getJson(`rooms/${code}/created`)]);
      const last = Math.max(Number(active) || 0, Number(created) || 0);
      const idleDays = last ? (now - last) / 86400e3 : Infinity;
      if (idleDays <= days) { kept++; return; }
      log(`${dry ? '會刪除' : '刪除'} ${code}（${last ? idleDays.toFixed(1) + ' 天沒人用' : '沒有時間欄位的殘留資料'}）`);
      if (!dry) {
        const r = await fetchFn(url(`rooms/${code}`), { method: 'DELETE' });
        if (!r.ok) throw new Error(`刪除 ${code} 失敗：HTTP ${r.status}`);
      }
      removed++;
    }));
  }
  log(`${dry ? '會刪除' : '已刪除'} ${removed} 個，保留 ${kept} 個。`);
  return { removed, kept };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GoogleAuth } = await import('google-auth-library');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (!sa) { console.error('缺少 FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
  const auth = new GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email'] });
  const token = await auth.getAccessToken();
  await cleanup({ token, days: Number(process.env.IDLE_DAYS) || 7, dry: process.env.DRY_RUN === 'true' });
}
