# 清理舊房間

房間資料存在 **Firebase Realtime Database**（不是 GitHub）。GitHub 只放網頁程式，所以要在 Firebase 主控台刪房間。

## 日常：在網站上刪

首頁「我的房間」列出你進出過的房間。**房主**（自己開的房間）旁邊有紅色「刪除房間」，按下去整間刪掉；對手那邊會看到「這個房間已經被刪除了」。對手的清單只有「移除」（只從清單拿掉，不影響房間）。

這份清單存在瀏覽器裡，所以只看得到「這個瀏覽器」進出過的房間。

## 手動：在 Firebase 主控台刪

1. 開 <https://console.firebase.google.com/>，進專案 **pokerole-battle**。
2. 左側選單 **建構（Build）→ Realtime Database → 資料（Data）**。
3. 展開 `rooms`，每個 6 碼的節點是一個房間。裡面的 `active`（最後使用）和 `created`（建立）是毫秒時間戳記，可以貼到 <https://www.epochconverter.com/> 換成日期。
4. 把游標移到要刪的房號上，右側會出現 **✕**，按下去、確認，就刪掉整個房間。
5. 想一次全清空：刪 `rooms` 這個節點本身（所有房間包含正在進行的都會消失，小心）。

## 自動：每月清理一週沒人用的房間

`.github/workflows/cleanup-rooms.yml` 每月 1 日（UTC 03:00）執行 `scripts/cleanup-rooms.mjs`：超過 7 天沒人用的房間整間刪除。「最後使用」＝ `active` 欄位（有人進房、出招就會更新），沒有就看 `created`。要啟用，只需一次設定：

1. Firebase 主控台 → 左上齒輪 **專案設定 → 服務帳戶（Service accounts）→ 產生新的私密金鑰**，下載一個 JSON 檔。
2. GitHub 儲存庫 → **Settings → Secrets and variables → Actions → New repository secret**，名稱填 `FIREBASE_SERVICE_ACCOUNT`，值貼上整個 JSON 檔的內容。存好後把下載的檔案刪掉（它等於資料庫的管理員密碼，不要上傳或傳給別人）。
3. 儲存庫的 **Actions** 分頁 → 左邊選「清理舊房間」→ **Run workflow**。第一次保持勾選「只列出會刪哪些房間」，看紀錄確認沒問題；之後取消勾選再跑一次就是真的刪。

注意：
- 公開儲存庫如果 60 天都沒有任何動作，GitHub 會自動停用排程；到 Actions 頁面按「Enable workflow」就恢復。
- 想改成別的天數，改 workflow 裡的 `IDLE_DAYS`。
- 本次更新前建立的舊房間沒有 `active`，以建立時間計算。
