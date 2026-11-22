<p align="center"><img src="assets/logo.png" alt="TomoPet" width="220"></p>

<h1 align="center">TomoPet</h1>

<p align="center"><em>A desktop pet that watches you play osu!: she comments on your plays, warns you before hard sections, talks with lip-synced voice, and shows up in OBS.</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Sorihiko/TomoPet?style=for-the-badge&label=license&labelColor=555555&color=FF66AA" alt="License"></a>
  <a href="https://github.com/Sorihiko/TomoPet/stargazers"><img src="https://img.shields.io/github/stars/Sorihiko/TomoPet?style=for-the-badge&label=stars&labelColor=555555&color=FF66AA" alt="Stars"></a>
  <a href="https://github.com/Sorihiko/TomoPet/releases"><img src="https://img.shields.io/github/v/release/Sorihiko/TomoPet?style=for-the-badge&label=tomopet&labelColor=555555&color=FF66AA" alt="Version"></a>
</p>

你打 osu! 的时候，她坐在桌面上看着：开局点评这张图，断连了呜哇一声，全连了得意一下，难段来之前提醒你，休息段喝口水。还能叠进 OBS，出现在录制和直播画面里。

## 功能

- **看你打 osu!**：通过 [tosu](https://github.com/tosuapp/tosu) 读对局数据（歌名、难度、mod、准确率、连击、miss……），在开局、连击关口、断连、掉准度、休息段、多人房超人 / 被超、重开、打完、失败时说一句，话由你配的模型写
- **怎么说**：屏幕下方字幕、桌面角色头顶冒气泡，或者只念出来；两句之间隔多久、每首几句、每天几句都能调
- **念出来**：火山引擎「豆包语音」/ Breeze TTS 2（云端）两家可切换；说话时嘴跟着声音的响度动
- **桌面角色**：自带 15 套 [CrossPet](https://github.com/lokicorvus/crosspet) 角色，按游戏时刻换姿势（断连「呜哇」、全连得意、休息段喝水、很久不动打哈欠睡着），摸头、戳她都有反应
- **难段预告**（默认开）：开图时读这张图的 `.osu`，在明显比别处难的长串（分得出宽间距串、断开的串、叠串）、大跳、先跳后串、变速前三四秒用一句话提醒你
- **脚下的 counter**：打图时她站在一个圆环上，粉色那截是进度、竖在环上的墙是难度曲线，下面是 pp 和 100 / 50 / miss（三种样子可选，桌面和 OBS 都有，可以关）
- **OBS**：角色和全屏字幕自动装进 tosu，OBS 里加个浏览器源就有，和桌面上用同一套皮肤
- **这是张什么图**：开局点评时带上 osu! 官网的玩家标签（User Tags，要填自己的 OAuth 应用，可选）和她自己从谱面看出来的（串多不多、有没有大跳）
- **自动更新**：有新版本时托盘提示，点一下下载、装好、自己重开（设置和数据不受影响；可以在「高级」里关掉）
- **人设**：她叫什么、怎么称呼你、怎么说话都写在 `persona.md` 里；一场打完记一条小结，下次知道你最近打得怎么样
- 可以开机自启（只待在托盘、不弹窗口）；设置窗口最上面的「下一步」会告诉你还差什么

完整说明见 [使用说明](docs/使用说明.md)。

## 安装

在 [Releases](https://github.com/Sorihiko/TomoPet/releases) 下载 `TomoPet-<版本>-win-x64.zip`，解压到普通文件夹（别放 Program Files），双击 `TomoPet.exe`，会打开设置窗口；关掉窗口后她还在托盘里看着，点托盘图标再打开。

| 要准备的 | 说明 |
|---|---|
| Windows 10 / 11 + osu!stable | 只在这套环境上验过 |
| [tosu](https://github.com/tosuapp/tosu/releases) | 第三方工具，开着它 TomoPet 才看得到对局；放在普通文件夹里运行 |
| 模型的 API Key | OpenAI 兼容接口（DeepSeek、通义、Kimi、OpenRouter、本地 Ollama……）或 Anthropic（Claude） |
| 语音（可选） | 火山引擎的 App ID / Access Key / 音色 ID，或 BreezeBlue 的 API Key，二选一 |

| OBS 浏览器源 | 地址 | 宽 × 高 |
|---|---|---|
| 角色 | `http://127.0.0.1:24050/fatfish-osu/` | 600 × 700 |
| 全屏字幕（可选） | `http://127.0.0.1:24050/fatfish-osu-subtitle/` | 和画布一样 |

设置和数据存在 `%APPDATA%\osu-pet\`（以前叫 osu-pet，内部名字没改）。API Key 用系统加密存在本机，只发给你填的那个接口。

## 构建

需要 Node.js 20 以上。

```powershell
npm install
npm start          # 启动（第一次会先打包渲染层、转换角色）
npm test           # 跑测试
npm run package    # 打包成 release/TomoPet-<版本>-win-x64.zip
```

<details>
<summary>角色立绘和张嘴口型（不在仓库里）</summary>

立绘和口型是 CC BY-NC-SA 4.0 的素材，和代码分开放，不进 git：

1. 下载 [CrossPet](https://github.com/lokicorvus/crosspet)，把 `characters` 文件夹放进 `art/crosspet/`。`npm start` / `npm run build` 时会转成 `skins-bundled/`
2. （可选）张嘴口型：`python scripts/mouths/make-mouths.py`（要 Python 3 + Pillow），按钉死的提交下载 [hunmer/aboutme-pets](https://github.com/hunmer/aboutme-pets) 的动画到 `art/hunmer/`，生成的嘴图在 `art/mouths/`，下次打包皮肤时拷进去
3. 打包给别人时（`npm run package`）会把转好的皮肤带上，最外层附「授权说明.txt」

离屏自检（真的启动程序、给每个窗口截图后退出，不碰真的 tosu 和你的数据）：

```powershell
$env:OSU_PET_HOME = "$env:TEMP\osu-pet-smoke-home"; $env:OSU_PET_SMOKE = "$env:TEMP\osu-pet-smoke-out"; npx electron .
```

目录、打包细节、设计说明见 [使用说明 · 开发](docs/使用说明.md#9-开发) 和 [DESIGN.md](docs/DESIGN.md)。
</details>

## 说明

非官方工具：只读 tosu 给的数据和本地的 `.osu` 文件，不改游戏。tosu、osu! 都不是这个项目的一部分，"osu!" 是 ppy Pty Ltd 的商标。

素材：角色立绘来自 [CrossPet](https://github.com/lokicorvus/crosspet)（CC BY-NC-SA 4.0，署名要带上原作者）；张嘴口型取自 [hunmer/aboutme-pets](https://github.com/hunmer/aboutme-pets)（CC BY-NC-SA 4.0）。都不在仓库里，只在打包版里，不得商用；每套皮肤的 `CREDITS.md` 写了署名和改动。

改编的代码：[SurfCore](https://github.com/Mieksido/surfcore)（MIT）、[surfpet](https://github.com/Mieksido/surfpet) 的分图层渲染器（MIT）、CrossPet 的动作关键帧（MIT），全文在 [licenses/](licenses)。

第三方：[Electron](https://github.com/electron/electron)（MIT）、[PixiJS](https://github.com/pixijs/pixijs)（MIT）、[@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)（Apache 2.0）、[esbuild](https://github.com/evanw/esbuild)（MIT，只在构建时用）。

语音可选 [Breeze TTS 2](https://breezeblue.ai)（BreezeBlue 云端）。

许可证：[MIT](LICENSE)（只覆盖代码；`assets/logo.png`、角色立绘、张嘴口型不在 MIT 的范围里，见 [NOTICE](NOTICE)）
