# 國中教育會考歷屆試題練習（115–111年）— CapQuiz

線上練習網站：<https://cap-quiz.pages.dev>

## 簡介

收錄 **115～111 學年度國中教育會考** 五科選擇題，共 **1,070 題**（每年 214 題）：

- **國文**：42 題／年（5 年共 210 題）
- **英文（閱讀）**：43 題／年（5 年共 215 題，附全題庫繁體中文翻譯）
- **數學（選擇）**：25 題／年（5 年共 125 題）
- **社會**：54 題／年（5 年共 270 題）
- **自然**：50 題／年（5 年共 250 題）

### 功能特色

- **首頁年度分頁**：支援 `115 / 114 / 113 / 112 / 111 / 全部年度` 分頁切換，並可自由點選國、英、數、社、自或該年度全部進行循序、隨機或錯題複習。
- **原卷高清截圖**：每題與題組皆附大考原卷裁切截圖（`images/q{id}.png`、`images/p_*.png`），完整保留數學公式、幾何圖形、地圖與統計圖表。
- **會考參考等級估算**：完成單一年度單科全卷測驗時，依 115–111 年各科官方對照表自動估算 `A++`～`C`（英、數標註為僅以選擇題正確率換算之參考等級）。
- **全題庫繁中詳解與英文翻譯**：內建全 1,070 題繁中詳解（`explanations_zh.json`）與 215 題英文科繁中翻譯（`translations.json`）。
- **完整練習工具**：支援立即批改／交卷批改、作答筆記、暫停／繼續測驗、全文搜尋、歷史紀錄與 JSON 匯入／匯出（資料儲存在瀏覽器 `localStorage`）。

## 專案結構

- `src/CapQuiz/wwwroot/` — 純靜態前端應用程式（HTML / CSS / Vanilla JS）與題庫資料（`data/`、`images/`）。
- `src/CapQuiz/Program.cs` — ASP.NET Core 靜態伺服器外殼（供本機開發執行）。
- `build/download_cap_pdfs.py` — 下載 115–111 年會考試題、官方答案與詳解 PDF。
- `build/parse_cap_pdfs.py` — 解析 PDF 產出 `questions.json`、`explanations_zh.json` 並自動裁切每題與題組原卷截圖。
- `pdf/cap/` — 115–111 年會考試題、官方答案與詳解 PDF 來源檔案。

## 本機執行

```powershell
# 方式 1：使用 .NET 執行
dotnet run --project src/CapQuiz

# 方式 2：在 wwwroot 目錄下啟動任意靜態 HTTP Server
cd src/CapQuiz/wwwroot
python -m http.server 8000
```

## 部署（Cloudflare Pages）

```powershell
npx wrangler pages deploy src/CapQuiz/wwwroot --project-name cap-quiz --branch main
```
