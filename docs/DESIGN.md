# TomoPet（原名 osu-pet）设计说明

> 目标：把 SurfCore 里「桌宠看你打 osu!」拆成一个**独立程序**。运行时不依赖 SurfCore、DSH，不读 `~/.dsh` 下的任何东西。
> 以后可能开源，所以**代码和受版权保护的素材分开**：仓库里只有代码（一套皮肤都没有；给别人的打包版里另外带 CrossPet 的角色）。

## 1. 整体结构

```
osu!  ──内存──▶  tosu（用户自己装）──ws://127.0.0.1:24050/websocket/v2──▶  TomoPet（一个 Electron 程序）
                                                                           │
   core/events.js   认出时刻（开局 / 连击 / 断连 / 掉准度 / 休息段 / 名次 / 重开 / 打完 / 失败 / 退出）
   core/watch.js    过闸（间隔 / 每首上限 / 每天上限 / 过时丢弃 / 排队）→ 拼提示词 → 调模型 → 整理成一句
   core/llm.js      模型：OpenAI 兼容 或 Anthropic，用户自己填 Key
   core/tts-volc.js 语音（可选）：火山引擎 V3，用户自己填 Key
                                                                           │
          ┌──────────────────────────────┬─────────────────────────────────┼──────────────────────────────┐
          ▼                              ▼                                 ▼                              ▼
   本地字幕窗口                  桌面角色窗口（第一版就做）      tosu counter：写 <tosu static>/fatfish-osu/state.json   设置窗口
   （透明、置顶、点不到、         透明置顶，说话时张嘴，           OBS 浏览器源：角色（张嘴）+ 气泡 / 脚下字幕；            （托盘图标打开）
    不抢焦点）一行字 + 声音；      可选头顶冒气泡；能拖动位置       另一个源 fatfish-osu-subtitle：铺满画面的字幕
    或只放声音
```

**一个进程**：Electron 主进程里跑服务、开字幕窗口、桌面角色窗口、设置窗口，放托盘图标。
`core/` 下全是普通 Node 模块（不 `require('electron')`），测试直接用 `node` 跑，不用起 Electron。

### 为什么选 Electron 而不是「Node 服务 + 浏览器里的设置页」

| | Electron 一个程序（选这个） | Node 服务 + 本地网页设置 |
|---|---|---|
| 字幕窗口 | 本来就要 Electron（透明、置顶、点击穿透只有它能做），同一个进程直接开窗口 | 还是得另外拉一个 Electron 子进程，两套东西 |
| 设置页 | 一个窗口，经 IPC 调服务，**不开本机端口**，不用防别的网页来调 | 要开 HTTP 端口，得加令牌防 CSRF / 别的程序乱调 |
| 选文件夹（导入皮肤、指定 tosu 目录） | 系统对话框 | 网页里只能让用户手抄路径 |
| 存 API Key | `safeStorage`（Windows DPAPI 加密，换台电脑 / 换个用户就解不开） | 只能明文 |
| 代价 | `npm install` 要下 Electron（约 100MB，国内要设镜像，README 写清楚） | 同样要 Electron（字幕窗口） |

## 2. 哪些照搬、哪些重写、哪些依赖要换

### 2.1 照搬（只改 import 路径和名字）

| SurfCore 里 | 新项目 | 说明 |
|---|---|---|
| `lib/osu/events.js` | `core/events.js` | 原样。纯函数，不碰网络和文件 |
| `lib/osu/watch.js` 的闸门、`describeEvent`、`mapDetail`/`bpmFeel`/`arFeel`、提示词、`shape()`、过时丢弃、排队、成绩、小结 | `core/watch.js` | 逻辑照搬；依赖换掉（见 2.3） |
| `lib/osu/overlay/subtitle.html` | `app/overlay/subtitle.html` | 样式照搬；`nodeIntegration` 换成 preload |
| `lib/osu/overlay/main.cjs` 的窗口参数（透明、`focusable:false`、`setIgnoreMouseEvents`、`screen-saver` 置顶、按屏幕高缩放） | `app/overlay-window.js` | 同一进程里开窗口，不再拉子进程、不走 IPC 管道 |
| `lib/osu/tosu-counter.js`：找 tosu（PowerShell 先切 UTF-8）、读 `tosu.env` 的 `STATIC_FOLDER_PATH`、`writeFileReplacing`（EPERM/EBUSY 重试后退回直接覆盖）、`ensureCounterSettings`、`rev`/`seq` | `core/tosu-counter.js` | 照搬；皮肤和渲染层的来源换掉（见 2.2） |
| `lib/osu/tosu-counter/counter.js`、`index.html`、`settings.json`、`metadata.txt`；`tosu-counter-subtitle/*` | `counter/` | 照搬；文件夹名、标题、提示文字换掉 |
| `lib/pet-video/video-rig.js` | `renderer/video-rig.js` | 原样（视频皮肤播放器） |
| `src/voice-tts.js` 的 `speakableText()`（4.8→4点八、97%→百分之97、17:38→17点38）、`wavDurationMs()` | `core/speakable.js` | 原样 |
| 测试 `test-osu-watch.mjs`、`test-osu-tosu-counter.mjs` | `test/` | 照搬断言，桩换成新的依赖形状 |

### 2.2 要重写的

1. **OBS 里的角色渲染**：SurfCore 是把桌宠 `dist/renderer.js`（feiyu-pet 的打包产物）拷进 tosu，再用 `shim.js` 假装一个 `window.pet`。
   新项目自己构建：
   - `renderer/rig.ts`：从 feiyu-pet 0.2.3 的 source map 还原的分图层 rig（PixiJS v8），**原样**；
   - `renderer/entry.ts`（新写，约 80 行）：读 `./skin/manifest.json`，`rig` 是 `video` 用 `VideoRig`，否则用 `PetRig`；按 shim 里的规则算缩放（人占下面 78%，顶上留给气泡）；
     提供 `window.__rig` / `window.__skin` / `window.__counterPet.command()` 给 `counter.js`（气泡定位、张嘴）。不再需要 `shim.js`；
   - `esbuild` 打成 `dist/renderer.js`（把 pixi.js 打进去），`npm run build`；`npm start` 前发现没构建会先构建。
2. **字幕窗口管理** `app/overlay-window.js`：原来 `overlay.js` 的 `say/stop/status` 接口不变，内部从「拉子进程 + 发消息」改成「同进程 BrowserWindow + webContents.send」。
   失败照旧带 `code/error/hint`（`overlay.failed`）。
3. **模型** `core/llm.js`（新写）：
   - `openai`：直接 `fetch`，`POST {baseUrl}/chat/completions`，`Authorization: Bearer`，`temperature: 1`。DeepSeek、通义、Kimi、本地 Ollama 之类都走这个；
   - `anthropic`：用官方 SDK `@anthropic-ai/sdk`（实现时改的：新模型的参数规则变得快，SDK 跟得上，错误也有类型）。默认模型 `claude-opus-5-5`；
     只写一句话，所以 `output_config.effort: "low"`（它的思考关不掉，只能让它少想）；不发 `temperature`（新模型会拒绝）；
     走官方地址时带上服务端的拒答兜底（`fallbacks: "default"`），被安全分类器误拦时由兜底模型接着写。
   - 统一返回 `{ text, usage, model }`；失败分成 `llm.no-key` / `llm.auth`（401/403）/ `llm.rate-limit`（429）/ `llm.http` / `llm.network` / `llm.timeout` / `llm.empty`，每个都带 hint。
4. **语音** `core/tts-volc.js`（新写，照着语音包 `voxd/engine/cloud.py` 的接口契约）：
   - `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，头 `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id`；
   - 资源编号按音色 ID 自动选：`S_…` → `seed-icl-2.0`，`…_uranus_bigtts` → `seed-tts-2.0`，其他 `…_bigtts` → `seed-tts-1.0`；也能手填；
   - 返回是多行 JSON、每行 base64 的 WAV 片段，首片的 RIFF 长度是 `0xFFFFFFFF`：拼 PCM、自己补一个正确的 WAV 头；成功码 `0` 和 `20000000`；
   - 送去合成前过 `speakableText()`；按文字 + 音色缓存 wav（`tts-cache/`，留最近 200 个）。
   - 抽象成 `synthesize(text) → { bytes, durationMs }`，以后加别的语音服务只换这一个文件。
5. **记忆** `core/journal.js`：SurfCore 是把一场打完的小结写进它的记忆系统。新项目自己存 `summaries.json`（最近 20 场），
   提示词里带最近 3 场的小结（替代原来的「记忆卡」那一段）。小结的写法照搬。
6. **设置和状态** `core/config.js` + `app/settings/`：见第 4 节。
7. **桌面角色窗口** `app/pet-window.js` + `renderer/pet-entry.ts`（新写，第一版就做）：
   - 和 OBS 用同一个 `rig.ts` / `video-rig.js` 和同一套皮肤，只是入口不同；
   - 透明、无边框、置顶、不进任务栏、不抢焦点；只有角色身上能点（按 rig 的 `hitTest` 切换点击穿透），按住能拖，位置记进设置；
   - 她开口时张嘴（有声音按声音长度，没有按字数）；「怎么说」多一个 `bubble`：在她头顶冒气泡（气泡定位照搬 counter.js 的 `headAnchor`）；
     气泡出在看得见的角色头上：桌面角色、OBS 里的角色（counter 装好了）都算。两个都看不见但开了「念出来」就只出声；
     三样都没有才整句不说（`osu.pet-hidden`，不调模型）。2026-11-20 改：原来桌面角色一藏就整句不说，只用 OBS 直播时一句都没有；
   - 同一个 tosu 里 SurfCore 的 `surfcore-xiaojingyu/state.json` 最近 30 分钟开过口：设置窗口提醒 `osu.other-watcher`（两个程序会各说一句、声音叠在一起）。只读那个文件的 `at`；
   - 托盘菜单里「显示 / 隐藏角色」「回到右下角」；
   - 限制和原来一样：osu! 用全屏独占时任何窗口都盖不上去，桌面角色和本地字幕都看不到（声音照常），所以录制 / 直播还是靠 OBS 那一份。

### 2.3 要换掉的依赖

| watch.js 原来用的 | 换成 |
|---|---|
| `chat.roleInfo()`（名字 + 人格卡） | 设置里的「角色名」+ 用户自己写的 `persona.md` |
| `chat.ownerInfo()` | 设置里的「你怎么称呼玩家」+ 「他 / 她 / TA」（提示词和 `describeEvent` 里的「他」改成这个，默认「他」） |
| `chat.memoryBlock()` | `journal.recent(3)` |
| `chat.complete()` / `chat.llmReady()` / `recordUsage` | `llm.complete()` / `llm.ready()`；用量记到状态里（今天调了几次、多少 token） |
| `chat.synthesize()` + `chat.readAudio()` + `voiceSettings()` | `tts.synthesize()` 直接给音频字节 |
| `tokenBudget.block('other')` | 去掉；保留「每天最多说几句」（`dailyLimit`）当花费上限 |
| `chat.online()` / `focusEnabled()` / `emit({type:'speak'})` / 气泡模式 | 自己的桌面角色窗口（2.2 第 7 条）：`petWindow.visible()` / `petWindow.speak()`。「怎么说」是 `subtitle`（字幕）/ `bubble`（角色头顶气泡）/ `none`（只念）；专注模式去掉 |
| `appendMemoryInboxEvent` / `activeMemoryPaths` | `journal.append()` |
| `store.js`（`readUnified`/`backupFile`/`writeJsonAtomic`）、`paths.js` 的 `STATE_DIR` | `core/store.js`：数据目录 + 原子写 + 改设置前备份 |
| 桌宠的 `dist/renderer.js`、`skins/`、`data/userdata/settings.json` | 自己构建的 `dist/renderer.js` + 数据目录里的 `skins/` + 设置里选的皮肤 |
| 桌宠那份 Electron | 项目自己的 `electron` 依赖 |

## 3. 皮肤：代码和素材分开

- 皮肤格式**沿用** feiyu-pet 的 `manifest.json`（`rig: "layered"` 分图层 / `rig: "video"` 视频），已有的皮肤不用改就能放进来。
- 皮肤放在**数据目录**的 `skins/<id>/`（不在仓库里）。设置里「导入皮肤」选一个带 `manifest.json` 的文件夹，程序拷进来；也可以手动放。
- 仓库里没有皮肤。原来有一个脚本画的占位小人（`skins-builtin/placeholder/`），2026-11-20 用户「把占位小人从我这个项目里整个删了」：
  默认皮肤改成程序自带的 DeepSeek（女仆装），选的那套没了就退回它、再退回第一套能用的；一套都没有时 `skin.none`（桌面角色不开，设置里说怎么办）。
  设置里存着旧默认值 `placeholder` 的当成「没选，用默认那套」。
- **不进仓库**：feiyu-pet 的立绘、Claude 娘素材（CC BY-NC-SA 4.0）。README 写「去哪拿、怎么导入」，`.gitignore` 挡住 `skins/`。
- tosu counter 同步时把**当前选的皮肤**拷进 `<static>/fatfish-osu/skin/`，换皮肤时 `rev` 加一，OBS 里的页面自己重载（和原来一样）。

## 4. 设置、数据、文件

数据目录：`%APPDATA%\osu-pet\`（Electron 的 `userData`，2026-11-20 改名 TomoPet 后在 app/main.js 里固定成这个名字，不跟着程序名变；环境变量 `OSU_PET_HOME` 可以改，测试和便携版用）。

| 文件 | 内容 |
|---|---|
| `config.json` | 全部设置；改之前备份到 `backups/`（留 10 份） |
| `persona.md` | 人设，用户自己写（第一次启动时从 `persona.example.md` 复制一份） |
| `plays.json` | 最近 60 把成绩 + 最近 7 天每天说了几句（照搬）+ 她最近说的 100 句（`lines`：字、模型原话、当时的图和成绩，设置「她最近说的」二级页用；声音只在内存里留 20 句给「再听一遍」） |
| `summaries.json` | 最近 20 场的小结 |
| `skins/` | 用户的皮肤 |
| `tts-cache/` | 合成过的 wav |

`config.json` 的形状：

```json
{
  "watch":   { "enabled": true, "url": "ws://127.0.0.1:24050/websocket/v2", "output": "subtitle", "voice": false,
               "midPlay": true, "minGapSec": 40, "perSongMax": 3, "dailyLimit": 150, "remember": true },
  "persona": { "name": "小鲸鱼", "ownerName": "主人", "ownerPronoun": "他" },
  "llm":     { "provider": "openai", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "<加密>" },
  "tts":     { "provider": "volc", "appId": "", "accessKey": "<加密>", "speaker": "", "resourceId": "" },
  "counter": { "enabled": true, "tosuDir": "" },
  "pet":     { "enabled": true, "skin": "crosspet-deepseek", "scale": 0.4, "x": null, "y": null },
  "rulers":  { "bpmVeryFast": 230, "bpmVeryFastNote": "他自己说过 240 左右就点不动了", "bpmFast": 200, "bpmSlowMax": 150, "arSlowBelow": 9, "arFastAbove": 10 }
}
```

- 字段白名单 + 类型检查 + 收敛范围照搬 `saveOsuWatchConfig`（间隔 10–600 秒、每首 0–10、每天 1–1000；tosu 地址只能是本机）。
- `rulers`（快慢的尺子）：默认值就是现在案例文档里你定的规矩（BPM ≥230 很快、200–229 偏快、151–199 中等、≤150 偏慢；AR <9 偏慢、>10 偏快；开局才带 BPM/AR/CS）。放进设置是为了开源后别人能改成自己的手感。
- API Key 用 `safeStorage` 加密存；状态和日志里一律显示成 `********`。

**设置窗口**（托盘图标点开）几块：状态（tosu 连没连上、现在在打什么、下一步该干什么、最近没说的事和原因、上一次失败的 code/error/hint）、
看 osu 的开关和规则、人设（名字 + 「打开 persona.md」）、模型（填 Key + 「测试」）、语音（填 Key + 「试听」）、OBS（装进 tosu、两条地址一键复制、预览、选皮肤、导入皮肤）、最近几把成绩。
所有失败都显示在窗口里（红字 + 下一步），不只写日志。

## 5. 失败码

照搬原来的 `osu.*`（`osu.tosu-offline`、`osu.no-output`、`osu.voice-failed`、`osu.config-invalid`、`osu.url-not-local`、`osu.counter-no-tosu`/`-bad-dir`/`-no-skin`/`-write`……），
新增 `llm.*`、`tts.*`（见 2.2），`osu.counter-no-pet` 换成 `osu.counter-no-renderer`（没跑 `npm run build`）。每个都是 `{ ok:false, code, error, hint }`。

## 6. 测试（Node 内置 `assert`，`npm test` 一次跑完）

| 文件 | 管什么 |
|---|---|
| `test/events.test.mjs` | 照搬：认数据、每种时刻、头一帧残留、回放、多人房名次 |
| `test/watch.test.mjs` | 照搬：闸门每条规则、描述文字、提示词、过时丢弃、排队、成绩和小结、连接和重连；桩换成 llm / tts / journal |
| `test/tosu-counter.test.mjs` | 照搬：找 tosu（含中文路径编码）、static 目录、EPERM 重试、settings 迁移、`seq`/`rev`；皮肤来源换成数据目录 |
| `test/llm.test.mjs` | 两家接口的请求形状、返回解析、每种失败码（假 `fetch`） |
| `test/tts-volc.test.mjs` | 资源编号选择、多行 JSON 拼 PCM、补 WAV 头、错误码、`speakableText` |
| `test/config.test.mjs` | 白名单、收敛、本机地址、Key 加密 / 脱敏、改前备份 |
| `test/skins.test.mjs` | 校验 manifest、导入（含中文路径）、退回默认那套、一套都没有时 `skin.none`、**仓库里没有任何立绘**（占位小人也删了） |
| `test/windows.test.mjs` | 字幕窗口和桌面角色窗口的管理逻辑（假窗口）：不抢焦点、点击穿透、位置、拖动、换皮肤、气泡、各种失败码；本地文件协议不越界 |
| `test/api.test.mjs` | 设置窗口的每个操作都返回 `ok` 或 `code / error / hint`、返回值和日志里没有密钥、只开允许的地址；「下一步」提示每种情况都有 |

不连真的 tosu、不调真的模型和语音。真窗口画出来的样子用**离屏自检**确认（`app/smoke.js`：把程序真的跑起来，给设置窗口、桌面角色、字幕、OBS 两页截图并读页面状态；
OBS 那一页用临时目录里的假 tosu + 本机网页服务，不碰真的 tosu）。
真机验收（连 tosu 打一把、看 OBS）写在 README 的「验收清单」里，由你来做（不用 computer-use，避免关掉英伟达即时回放）。

## 7. 和 SurfCore 同时开会怎样

两边都会连 tosu、都会说话、都会往 tosu 里装 counter（文件夹名不同，不会互相覆盖）。用 TomoPet 时把 SurfCore 的「看你打 osu!」关掉。
OBS 里原来的两个浏览器源地址要换成新的：`http://127.0.0.1:24050/fatfish-osu/` 和 `http://127.0.0.1:24050/fatfish-osu-subtitle/`。

## 8. 拍板记录

| # | 问题 | 结论 |
|---|---|---|
| 1 | 程序形式 | **A：Electron 一个程序**（2026-11-20 用户选的；对比见 8.1） |
| 2 | 桌面上显示角色 | **第一版就做**（2.2 第 7 条），可选头顶气泡 |
| 3 | tosu 里的文件夹名 | **`fatfish-osu` / `fatfish-osu-subtitle`** |
| 4 | feiyu-pet 的 `rig.ts` | 一开始作者 / 授权不确定，先只自用。**2026-11-20 查清**：feiyu-pet 的源码仓库是公开的 [surfpet](https://github.com/Mieksido/surfpet)（和 SurfCore 同一作者），MIT，Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors；我们的 `rig.ts` 和上游当前版本逐字节相同。用户同意打包版带上它（原来打包时用替身顶替）。署名：`rig.ts` 文件头、`NOTICE` 第 2 条、`licenses/surfpet-MIT.txt`（MIT 全文），打包版收进 `THIRD-PARTY-NOTICES.txt`。surfpet 的立绘不在 MIT 里，仍然不能发布 |
| 5 | 第一版不做 | Claude 娘素材转换工具、别家语音服务、自动下载 tosu（放第二批） |

### 8.1 程序形式的几种选法

| 形式 | 本地字幕 / 桌面角色 | 设置界面 | 装起来 | 缺点 |
|---|---|---|---|---|
| **A. Electron 一个程序**（原方案） | 能（透明、置顶、点击穿透） | 程序里的窗口 | `npm install` 下 Electron 约 100MB；可打成一个 exe | 体积大 |
| B. Node 服务 + 浏览器设置页 + Electron 子进程 | 能（子进程开窗口） | 浏览器打开本机网页 | 同 A，还多一个本机端口 | 两套东西，端口要防别的网页乱调 |
| C. Tauri（系统自带的 WebView2 + Rust 外壳） | 能 | 程序里的窗口 | 安装包十几 MB | 要装 Rust 工具链才能构建；照搬的 Node 代码得放进一个 Node 子进程，或者改写成 Rust，等于重写一大半 |
| D. 只有 Node，不要窗口 | **不能**：没有本地字幕、没有桌面角色；声音用 Windows 自带的播放器放；角色和字幕只在 OBS 里 | 浏览器打开本机网页 | 只要装 Node，不下 Electron | 和「桌面上显示角色」冲突 |

你打 osu! 用全屏独占（为了英伟达即时回放），这时本地字幕和桌面角色本来就盖不上去，只有不打的时候看得见；OBS 里那份不受影响。
既然要桌面角色，能选的就是 A / B / C：**推荐 A**（照搬最多、一个进程、不开端口）；C 体积最小，但代价是大量重写。

## 9. 实现时和草案不一样的地方

| 草案 | 实际 | 为什么 |
|---|---|---|
| 窗口从 `file://` 加载 | 自己登记了一个协议 `osupet://local/…`（`core/local-files.js`），页面、渲染层、皮肤都从它走 | 网页里 `fetch()` 读不了 `file://`（皮肤清单要 fetch）；页面和皮肤图片要同源，PixiJS 才能把图传进 WebGL。只认 app / dist / assets / skin 四个前缀，解析后不许跑到文件夹外面 |
| 拷文件夹用 `fs.cpSync` | 自己写的逐文件拷贝 `copyDirSync` | 测试抓到的：Node 24 的 `fs.cpSync` 在 Windows 上遇到中文路径会把目标路径写成乱码，而 tosu 就装在 `D:\游戏用\` |
| Anthropic 直接 `fetch` | 官方 SDK | 见 2.2 第 3 条 |
| `counter.skin` | 只有 `pet.skin`，桌面和 OBS 用同一套 | 两处选不同皮肤没有实际用处，少一个会选错的地方 |
| 设置页的「下一步」写在页面里 | `core/next-step.js` 纯函数 | 好测；每种挡路的情况都钉了一条断言 |
| — | `assets/logo.png`：托盘 / 窗口 / 设置页的图标（2026-11-20 用户给了 logo） | 没放这个文件时托盘是空白图标，「下一步」里提醒 |
| — | 设置「快慢的尺子」可改 BPM / AR 的分界和「很快」时补的那句话 | 默认值是你定的；开源后别人能改成自己的手感 |

还没做（第二批）：Claude 娘素材的转换工具、别家语音服务、自动下载 tosu、打包成安装程序（现在是 npm start 或双击 start.bat）。

## 10. 姿势皮肤：按游戏时刻换姿势（2026-11-20）

**为什么**：比较过三种角色来源后，用户选了 CrossPet 的立绘。

| 来源 | 优点 | 为什么没选 / 怎么用 |
|---|---|---|
| psd2live 自动绑定 fisharchive 的立绘 | 能做出会动的 Live2D 式角色 | 那些图是压平的，拆层补画每张要十几小时 |
| 来源不明的 8 个 Live2D 模型 | 会眨眼、对口型、头发物理 | 只有 4 个表情，打完和失败几乎一样；要 Live2D 的专有 Core；来源和授权都不明 |
| **CrossPet**（选了这个） | 每个角色约 60 张姿势，正好对上 osu! 的时刻；授权写得清楚（CC BY-NC-SA 4.0） | 静态图，没有张嘴的帧：说话时只换姿势、轻轻点头 |

CrossPet 的程序本身不用：它没有 OBS 输出，全屏游戏时会藏起来，气泡只能说它自带的台词。只拿它的图。

**链路**：

```
events.js 认出事件 ──▶ moments.js 归成时刻（combo-break、fc、retry-rage……）
     │
     └─ watch.js handleEvent：先发姿势（不管这一下说不说话），再过说话的闸门
          ├─ pet-window.js react ──pet:command──▶ 桌面角色页面 ──▶ sprite-rig.ts
          └─ tosu-counter.js react ──state.json（reactSeq / react / playing / playingAt）──▶ OBS 页面 counter.js ──▶ sprite-rig.ts
```

- **姿势不跟着说话的闸门走**：断连了就该露出「呜哇」的样子，哪怕这一下她没说话（间隔、每首上限只管说话）。
- **「打图中」**：开局 / 重开打开，打完 / 失败 / 退出关上；tosu 断了、功能关了、程序退出、对局悄悄没了也关上。
  打图中每 30 秒给 OBS 页面一次心跳，页面 90 秒没收到就自己放下：TomoPet 崩了也不会让 OBS 里的她一直停在打图的姿势。
- **休息段结束**：events.js 原来不报（SurfCore 原版没有），加了 `break-end`，只用来放下水杯，不说话。
- **说话时**：刚发生的事（12 秒内开始的反应）的姿势陪着这句话一直摆着——模型写一句话要几秒，不然话还没出来姿势就收了。
- **优先级**：打完 / 失败 > 全连断了 > 普通断连 > 连击关口；低的不打断刚开始不到 2.5 秒的高的，免得一首图里姿势乱闪。
- **渲染**：`sprite-director.js`（纯逻辑，Node 测试）决定现在摆什么；`sprite-rig.ts` 负责两张图交替淡入、CSS 小动作
  （改编自 CrossPet 的 MIT 关键帧）、待机眨眼、按图的透明度判断点没点到她。和 PetRig / VideoRig 同一套方法，桌面和 OBS 共用。
- **导入**：`crosspet-import.js` 只拷用得上的约 20 个姿势（缺的换成最接近的，比如 Claude 没有 happy 就用 roll_call），
  原样不改，写 `CREDITS.md`。不拷 character.json（里面的台词也是 CC BY-NC-SA）。仓库里没有 CrossPet 的图。
- **默认全有**（2026-11-20 用户：「不需要导入 crosspet 选项，默认就全有」）：设置里的「导入 CrossPet 角色…」去掉了。
  图放在程序文件夹的 `art/crosspet/`，`npm start` / `npm run build` 时 `bundleCrossPet` 转成 `skins-bundled/crosspet-<角色>/`
  （每套带 `.bundled.json` 记下源文件的指纹，没变就跳过；源里删掉的角色只删自己转出来的）。`skins.js` 找皮肤的顺序是
  数据目录 → `skins-bundled/`，同名时前面的优先。两个文件夹都在 `.gitignore` 里：代码和立绘照样分开。
  为什么不在程序启动时往数据目录里拷：每次启动都要比对几十 MB；而且从 Claude 桌面版之类的 MSIX 应用里跑命令时，写 `%APPDATA%`
  会被重定向（2026-11-20 真机踩过），转到程序文件夹里没有这个问题。
- **顺手修的**：tosu-counter 原来只看 manifest.json 判断皮肤变没变，换了图没改清单时 OBS 里一直是旧的；现在看清单 + 每个文件的大小和修改时间。

验证：`test/moments.test.mjs`、`test/sprite.test.mjs`；离屏自检设 `OSU_PET_SMOKE_CROSSPET=<CrossPet 某个角色文件夹>`，
会导入、换上，给桌面和 OBS 页面各发一串时刻并截图。
