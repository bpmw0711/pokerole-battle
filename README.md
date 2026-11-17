# Pokerole 3.0 線上對戰

朋友之間用的 Pokerole 3.0 單打對戰工具。規則依原書，自動擲骰、判定輪到誰、算傷害，招式與特性的特殊效果用「手動調整」補上。

## 怎麼玩
1. 開啟網頁，輸入名字，到「管理隊伍」建立隊伍。隊伍存在自己的瀏覽器裡。
2. 一個人按「建立房間」，把「邀請連結」或房號傳給對手。
3. 雙方選隊伍、選首發，開始對戰。
4. 房間滿了以後，其他人打開連結會以觀戰模式進入。
5. 重新整理或斷線後，用同一個瀏覽器打開連結就能回到原本的位置。

規則判定方式與改編見 [RULES-NOTES.md](RULES-NOTES.md)。

## 開發
- `js/engine.js`：規則引擎，對戰狀態由「操作＋擲出的骰面」的紀錄重算。
- `js/moves.js`：招式判讀。
- `js/net.js`：Firebase（匿名登入＋Realtime Database）。
- `js/app.js`：畫面。
- `data/db.json`：由規則站專案的 `tools/build_battle_data.mjs` 產生。
- 測試：`node --test test/engine.test.mjs`
- 本機測試兩個玩家：網址加上 `?guest`，每個分頁會用不同的一次性身分。
