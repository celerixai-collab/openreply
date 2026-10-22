# 7-brain：Leo 剪輯室的第二大腦

OpenReply 的 AI 私訊助理回答粉絲問題時用的知識庫。用 Obsidian 打開這個資料夾來看、來改，Claude Code 負責整理。

- 先看 [index.md](index.md)（目錄），規則在 [CLAUDE.md](CLAUDE.md)
- 會變的事實（日期、連結、方案）只寫在 [current.md](current.md)
- AI 答不出來、還在等 Leo 回答的問題在 [gaps.md](gaps.md)

這個 repo 是公開的：**粉絲的真實私訊、個資、金鑰都不能放進來。**

## 用 Obsidian 打開
1. 從 https://obsidian.md 下載安裝（免費）。
2. 選「開啟資料夾作為資料庫」（Open folder as vault），選 `openreply/7-brain`。
3. 設定 → 核心外掛：打開「範本」（範本資料夾設成 `_範本`）和「Bases」。不用裝社群外掛。

## 結構
| 位置 | 放什麼 |
|---|---|
| `01-raw/` | 原始資料：Leo 的口述、草稿、研究報告。永遠不改 |
| `02-wiki/產品/` | 剪輯室是什麼、風格、成果 |
| `02-wiki/常見問題/` | 一題一頁，標題就是粉絲會問的那句話 |
| `02-wiki/規則/` | 禁區、轉給 Leo 的情況、角色與語氣（內部用，不對粉絲講） |
| `03-output/` | 同步到 OpenReply 的內容、測試案例 |
| `_範本/` | 新頁面範本 |

做法參考：Karpathy 的 LLM Wiki，以及 Leo OS 競品清單裡 AI with Max、Ten Fold、Learn AI with Mariah、Cindy Zhu、MavGPT 的教學（比較見 `01-raw/research/second-brain-sources.md`）。
