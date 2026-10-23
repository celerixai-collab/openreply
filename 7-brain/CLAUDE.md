# 第二大腦規則（Claude 每次打開這個資料夾都要照做）

這個資料夾是「Leo 剪輯室」的知識庫，給 OpenReply 的 IG 私訊助理用。一律用台灣繁體中文。

## 資料夾
- `01-raw/`：原始資料。**永遠不改、不刪、不搬。**
- `02-wiki/`：從 raw 整理出來的頁面。一頁一個主題，150–400 字。
- `03-output/`：產出（同步到 OpenReply 的內容、測試案例）。
- `current.md`：會變的事實。日期、連結、方案、版本只寫在這裡，其他頁面用 [[current]] 連過來。
- `index.md`：目錄，每頁一行。新增、改名、刪除頁面時一定要更新。
- `gaps.md`：AI 答不出來的問題。
- `log.md`：每次變動加一行 `## [YYYY-MM-DD] 動作 | 標題`，只加不改。

## 頁面格式
- 檔名＝標題，寫成粉絲會問的那句話（例如「不會寫程式可以用嗎？」）。
- 用 `_範本/常見問題範本.md` 的欄位：title、questions（粉絲 3–6 種問法，中英都可）、answer_short（可以直接回的 1–2 句）、audience（fan／buyer／student／internal）、public（true 才能對粉絲講）、status（draft 草稿／live 已確認／outdated 過期）、updated、source、related。
- 頁面之間用 `[[標題]]` 互連。

## 回答粉絲（OpenReply 私訊助理）
1. 先讀 current.md，再讀 index.md，只打開相關的 1–3 頁。
2. 只能用大腦裡的內容回答。價格、日期、連結只能從 current.md 拿。
3. 找不到答案、或那頁是 `status: draft`／`public: false`，就不猜，回「好問題！這個我先記下來，確認後回你 🙌」，並把問題加進 gaps.md。
4. 規則頁（`02-wiki/規則/`）一定要遵守。

## Leo 說的話
- 「更新：…」：只改 current.md（或相關的那一頁），寫進 log.md。
- 「整理」：讀 01-raw 裡還沒處理的檔案，更新或新增 02-wiki 的頁面、index.md、log.md。先列出要動哪些頁面。
- 「檢查」：找重複、互相矛盾、跟 current.md 不一致、超過 60 天沒更新、沒被連到的頁面。只列出來，不自己刪。
- 封存或刪除頁面一定要 Leo 同意。Leo 確認過的頁面才能改成 `status: live`。

## 安全
這個 repo 是公開的。粉絲的真實私訊、名字、Email、金鑰、付款資料一律不放進來。
