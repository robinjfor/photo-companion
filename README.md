# Photo Companion

上傳一張照片，網頁裡會先用 MediaPipe 建臉部網格，然後：

- **idle**：呼吸、輕微擺頭、不定期眨眼
- **說話**：Grok（或任何 OpenAI 相容 endpoint）回文字 → Grok TTS 出聲 → 音訊能量 + 粗 viseme 驅動嘴唇
- **金鑰**：只打本機 `server.py`，由伺服器轉送 `https://api.x.ai/v1`

這不是 MuseTalk / LatentSync。瀏覽器沒有 GPU 擴散模型，做不到「長出新的牙齒與舌」。它保身分、對上開合與圓唇，適合網頁即時陪伴。之後若要寫實對嘴，可以把渲染層換成 LiveTalking，對話與 TTS 這層不用改。

## 啟動

```bash
cd photo-companion
python3 server.py
```

瀏覽器開 http://127.0.0.1:8787

1. 上傳正面單人照
2. 在「設定」貼上 [xAI API key](https://console.x.ai/)
3. 對話或按「聽」

沒有金鑰也能看 idle。說話會退回瀏覽器 `speechSynthesis`，對嘴比較粗。

## 設定

| 欄位 | 預設 | 說明 |
|---|---|---|
| API key | （本機 localStorage） | 也可改設環境變數 `XAI_API_KEY` |
| base URL | `https://api.x.ai/v1` | OpenRouter / 自架代理只要是 OpenAI chat + 同主機 `/tts` 就能試 |
| model | `grok-4-latest` | 也可填 `grok-4.7` 等 |
| voice | `eve` | `ara` / `leo` / `rex` / `sal` |
| language | `zh` | 傳給 TTS 與語音辨識 |

Chat：`POST {base}/chat/completions`（stream）  
TTS：`POST {base}/tts`（xAI Voice API，`voice_id` + `language`）

## 口型怎麼做的

1. 照片進頁面時跑一次 Face Landmarker（478 點）
2. 對 2D 點做 Delaunay，得到固定拓樹
3. 每幀只動頂點：眼皮閉合、唇環開合、嘴角拉伸／啵嘴、下頸微下
4. 音訊用 Web Audio analyser：RMS 控制張開，低頻比控制圓唇，spectral flux 補子音
5. 同時用正在唸的字做粗 viseme，避免只有音量、沒有口形變化

## 限制

- 側臉、墨鏢、手擋嘴、太小的臉會偵測失敗
- 張大嘴時可以看到原圖牙齒被拉開，不是生成的口腔
- Chrome 的 Web Speech API 才能用「聽」；Safari 請打字
- 同一顆 `<audio>` 只能 `createMediaElementSource` 一次，不要刷新頁面前反覆熱重載腳本

## 下一步（若要更像影片）

把 `avatar.js` 整段換成對 LiveTalking / MuseTalk 的 WebRTC 播放器，`app.js` 的 chat + tts 流程可沿用。
