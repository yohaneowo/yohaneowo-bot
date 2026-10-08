# yohaneowo-bot

个人用的 Discord bot：

- **资产报告**：汇总 Binance、Bybit、Pionex 的资产，附带恐惧贪婪指数和 MSTR mNAV。可以用 `/portfolio` 查询，也会每天定时发送日报。
- **上线私信**：从闲置变成在线时，私信一份资产快照（冷却 3 小时）。
- **链接解析**：
  - 在 bot 所在的服务器或 bot 私信里贴链接，bot 会自动解析并上传内容。
  - 在任何地方（包括和朋友的私信）右键消息 →「应用 → 解析链接」，或输入 `/x url:<链接>`。

  | 网站 | 内容 | 方式 |
  |---|---|---|
  | TikTok | 影片（优先选上传上限内画质最高的 H.264，超过上限就压缩） | yt-dlp |
  | Facebook | 公开贴文的作者、内文和第一张图 | 链接预览资料，不需要登录 |
  | Instagram | 公开的 reel 和影片贴文下载影片；受限内容只显示封面、作者和内文 | 先用 yt-dlp，失败时改用链接预览资料 |
  | 小红书 | 影片笔记（720p，超过上限就压缩）；图文笔记回复"暂未开放" | [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) 的 API |
  | YouTube | 只支持 Shorts（`youtube.com/shorts/…`），影像和声音分开下载再合并，最高 1080p | yt-dlp（用 Node 作为 JS 执行环境） |
  | Threads | 文字、图片、影片、多图贴文（最多 10 个），引用贴文会显示被引用的影片和图片 | Threads 网页自己用的 GraphQL 接口，不需要登录 |

  Threads 没有 yt-dlp 解析器，bot 直接调用 Threads 网页使用的接口（做法参考 [vxThreads](https://github.com/everettsouthwick/vxThreads)）。接口需要的查询 ID 和参数会随着 Threads 更新而改变，所以 bot 会从 Threads 的网页脚本中自动读取，缓存 12 小时，查询失败时重新读取。

  需要压缩的影片，如果压缩后的视频码率会低于 700 kbps（10 MB 上限下大约 90 秒），就不发送，改为回复"影片太长，建议直接到原网站观看"。原片本来就在上限以内的影片不受影响。

  Facebook 的限制：拿不到影片文件（影片贴文只能显示封面），多图贴文只能拿到第一张，私人或仅好友可见的贴文会解析失败。

  Instagram 的限制：有年龄或受众限制的内容需要登录才能看，bot 不登录，所以只显示封面并标注"无法下载影片"。Instagram 对未登录的请求有频率限制，短时间内解析太多会被暂时挡住。

  小红书：App 分享出来的链接没有 `xsec_token`，网页版和 yt-dlp 都会被导到登录页。所以另外跑一个 XHS-Downloader 服务来取得笔记资料。它不需要登录，但没有 cookie 时影片只有 720p。NAS 上由 `compose.nas.yaml` 启动，开发时由 `npm run dev` 启动。

  支持的网站列在 `services/media.js` 的 `SUPPORTED_SITES`，每个网站在 `services/sites/` 里有自己的处理函数。

## Discord 设置

### Intent（Developer Portal → Bot → Privileged Gateway Intents）

| Intent | 特权 | 何时需要 | 用途 |
|---|---|---|---|
| Guilds | 否 | 一直需要 | slash 命令、频道 |
| **Presence Intent** | ✅ | 设置了 `MASTER_ID` | 检测闲置 → 在线，触发私信 |
| **Message Content Intent** | ✅ | `MEDIA_AUTO_DOWNLOAD=true` | 读取消息中的影片链接 |
| Guild Messages / Direct Messages | 否 | `MEDIA_AUTO_DOWNLOAD=true` | 接收群组与私信的消息事件 |

`/x` 和「解析链接」不需要任何特权 intent，只有自动解析需要。

> 只有带 ✅ 的特权 intent 需要在 Portal 手动打开，其他由代码自动申请。
> 代码申请了特权 intent 但 Portal 没打开时，bot 会以 `Used disallowed intents` 登录失败。
> 稳定版和测试版是两个不同的 Application，**要分别打开**。

### 服务器权限（服务器设置 → 身份组 → bot 的身份组）

| 权限 | 用途 |
|---|---|
| 查看频道 | 读取频道、发送日报 |
| 发送消息 | 日报、影片回复 |
| 嵌入链接 | 资产报告的 Embed |
| 附加文件 | 上传影片 |
| 阅读消息历史 | 回复（reply）原消息 |
| 管理消息 | 可选：自动解析成功后删除原链接消息；没有这个权限时只是不删除 |

权限在服务器里设置，不需要回 Developer Portal。bot 已经在服务器里的话，直接修改它的身份组即可。

### 邀请链接

把 `<CLIENT_ID>` 换成该 bot 的 Application ID：

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=125952
```

`125952` 包含上表全部权限。不需要删除原链接的话，用 `117760`（不含管理消息）。

### 用户安装（在和朋友的私信里使用）

bot 无法读取两个用户之间的私信，所以那里只能由你主动触发，没办法自动解析。

1. 在 Developer Portal 打开 **Installation** 页面，在 Installation Contexts 勾选 **User Install**，并在 Default Install Settings 的 User Install 里加入 `applications.commands` scope。
2. 用 Installation 页面上的链接安装，选择「添加到我的应用」。
3. 执行 `npm run deploy`（或 `deploy:dev`）。`/x` 和「解析链接」会注册成**全局命令**，`/portfolio` 等命令仍然只注册到 `GUILD_ID`。
4. 在私信里右键含链接的消息，选择「应用 → 解析链接」，或输入 `/x`。回复双方都看得到。

> Developer Portal → Bot 里的 **Public Bot** 建议关闭。否则任何人都能安装这个 app，并用你的 NAS 下载影片。

### 其他限制

- 私信里 bot 无法删除用户的消息，这是 Discord 的限制，所以在私信里只会回复影片，不会删除原链接。
- 上线私信要求 bot 与你在同一个服务器里，而且你允许接收该服务器成员的私信。
- bot 上传文件的上限跟随服务器加成等级：未加成或私信为 10 MB，2 级 50 MB，3 级 100 MB。超过上限的影片会自动压缩。

## LINE

`line.js` 是独立的进程，和 Discord bot 共用 `services/media.js`。在 bot 所在的群组，或和 bot 的一对一聊天里贴链接，bot 会回复一则文字（作者、内文、链接）和影片或图片。

LINE 不支持上传文件，只能由 LINE 从网址下载。所以 `line.js` 同时提供：

- `/webhook`：接收 LINE 推送的消息，会验证签名；
- `/media/<随机ID>/…`：对外提供下载好的影片和图片，24 小时后自动删除。

这两个都通过 Cloudflare Tunnel 公开在 `https://line.yohaneowo.com`。

### 和 Discord 版的差别

- 不能编辑消息，所以没有处理进度。一对一聊天会显示 LINE 的"处理中"动画，群组里没有提示。
- 不能删除原链接消息，也不能在你和朋友的私聊里使用。要私下分享，就开一个只有你、朋友和 bot 的群组。
- 一则消息最多解析 2 个链接（一次回复最多 5 则消息）。
- 回复（reply）免费，但 reply token 很快就会失效。下载太慢错过时效时，会改用推送（push），push 要计入每月的消息额度，而且群组里**每个成员都算一则**。设置 `LINE_PUSH_FALLBACK=false` 可以关闭这个行为，错过时效就直接放弃。

### 设置步骤

1. 在 [LINE Official Account Manager](https://manager.line.biz) 建立官方帐号：
   - 在「设置 → Messaging API」启用 Messaging API；
   - 在「设置 → 帐号设置」允许加入群组；
   - 在「回应设置」关闭自动回应消息和加入好友的欢迎消息。
2. 在 [LINE Developers](https://developers.line.biz/console/) 打开这个 channel：
   - 在 Basic settings 复制 **Channel secret**；
   - 在 Messaging API 页面发行 **Channel access token**（long-lived）。
3. 在 Cloudflare Zero Trust 的「Networks → Tunnels」建立 tunnel（类型选 cloudflared），复制 tunnel token。然后加一个 Public Hostname：`line.yohaneowo.com` → `http://line-bot:8787`。
4. 在 NAS 的 `.env` 里加上下表的 LINE 变量和 `CLOUDFLARE_TUNNEL_TOKEN`，用 `compose.nas.yaml` 启动。
5. 回到 LINE Developers 的 Messaging API 页面：
   - Webhook URL 填 `https://line.yohaneowo.com/webhook`，打开 **Use webhook**，按 **Verify** 应该会显示成功。
6. 把官方帐号加为好友，再邀请进群组。

### 本机测试

`npm run dev` 会同时启动 Discord bot、Cloudflare tunnel 和 LINE bot，并**自动把 LINE 的 Webhook URL 设好、验证通过**。需要先打开 Docker Desktop，因为 tunnel 是在 Docker 里跑的。

tunnel 有两种模式，由 `.env.dev` 决定：

| `.env.dev` | 公开网址 |
|---|---|
| 有 `CLOUDFLARE_TUNNEL_TOKEN` | 固定网址，例如 `line-dev.yohaneowo.com`，就是 `LINE_PUBLIC_URL`。在 Cloudflare 建一个测试用的 tunnel，Public Hostname 指向 `http://host.docker.internal:8787` |
| 没有 | 临时网址 `https://xxxx.trycloudflare.com`，每次启动都不同，自动当作 `LINE_PUBLIC_URL` 使用 |

> 测试版和稳定版要用**不同的 LINE channel**（和 Discord 一样分成两个 bot）。dev 脚本会改写 channel 的 Webhook URL，共用同一个 channel 的话，正式环境会被导到你的电脑。

`npm run dev -- --line-only` 只启动 LINE 的部分；`npm run dev:dc` 只启动 Discord bot。

## 环境变量

稳定版用 `.env`，测试版用 `.env.dev`。两个文件都已被 git 忽略。

| 变量 | 必填 | 说明 |
|---|---|---|
| `TOKEN` | ✅ | bot token |
| `CLIENT_ID` | ✅ | Application ID，注册 slash 命令时使用 |
| `GUILD_ID` | ✅ | slash 命令要注册到的服务器 |
| `PORTFOLIO_CHANNEL_ID` | | 日报发送的频道；留空则不发日报 |
| `PORTFOLIO_CRON` | | 日报时间，默认 `0 9 * * *`（Asia/Shanghai） |
| `SEND_PORTFOLIO_ON_BOOT` | | 设为 `true` 时，启动后立刻发一份日报 |
| `MASTER_ID` | | 接收上线私信的用户 ID；留空则关闭此功能，也不会申请 Presence Intent |
| `MEDIA_AUTO_DOWNLOAD` | | 设为 `true` 时开启消息中链接的自动解析，需要 Message Content Intent |
| `BINANCE_API_KEY` / `BINANCE_SECRET` | | 只读 API key |
| `BYBIT_API_KEY` / `BYBIT_SECRET` | | 只读 API key |
| `PIONEX_API_KEY` / `PIONEX_SECRET` | | 只读 API key |
| `YTDLP_PATH` / `FFMPEG_PATH` | | 默认使用 PATH 里的 `yt-dlp` / `ffmpeg` |
| `LINE_CHANNEL_SECRET` | LINE ✅ | LINE channel secret，用来验证 webhook 签名 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE ✅ | LINE channel access token（long-lived） |
| `LINE_PUBLIC_URL` | LINE ✅ | LINE 下载影片和图片用的公开网址，例如 `https://line.yohaneowo.com` |
| `LINE_PORT` | | 默认 `8787`（Windows 会保留 3000 附近的端口） |
| `LINE_PUSH_FALLBACK` | | 默认开启；设为 `false` 时，reply 超时就放弃，不改用 push |
| `LINE_MEDIA_DIR` | | 存放对外文件的目录，默认在系统暂存目录下 |
| `XHS_API_URL` | | XHS-Downloader 的网址。NAS 的 compose 已经设好；开发时不设的话，`npm run dev` 会自动启动一个 |
| `FFPROBE_PATH` | | 默认使用 PATH 里的 `ffprobe`，用来读取影片长度 |
| `CLOUDFLARE_TUNNEL_TOKEN` | NAS | `compose.nas.yaml` 里的 cloudflared 会用到 |
| `ADMIN_API_URL` | | yohaneowo-admin 后端的网址，例如 `http://localhost:8001`；设了才会把所在的服务器、群组和活动时间上报给后台 |
| `ADMIN_API_TOKEN` | | 跟 admin 的 `BOT_API_TOKEN` 填同一个值 |

> 测试版的 `PORTFOLIO_CHANNEL_ID` 和 `MASTER_ID` 建议留空或改成测试用的值，否则两个 bot 会重复发送日报和私信。

## 开发（测试 bot，`develop` 分支）

本机需要 Node 22+、ffmpeg，以及带 curl-cffi 的 yt-dlp（TikTok 需要模拟浏览器，否则会被拦截）：

```bash
pip install -U "yt-dlp[default,curl-cffi]"
```

```bash
npm install
npm run deploy:dev   # 注册 slash 命令（只在新增或修改命令时需要）
npm run dev          # 使用 .env.dev 启动 Discord + LINE（含 tunnel）
```

## 部署（稳定版，`main` 分支）

镜像发布在 Docker Hub：`yohane0w0/yohaneowo-bot`。yt-dlp 和 ffmpeg 已经装在镜像里。

同一个 Docker Hub 仓库用 tag 区分版本：

| tag | 内容 | 发布指令 | NAS 用的 compose |
|---|---|---|---|
| `latest` | `main`（稳定版） | `npm run docker:release`（在 `main` 分支执行） | `compose.nas.yaml` |
| `dev` | `develop`（测试版） | `npm run docker:dev`（在 `develop` 分支执行） | `compose.nas.dev.yaml` |

指令会用**当前工作目录的代码**来 build，所以执行前要先切到对应的分支。

NAS 上使用 `compose.nas.yaml`，它只拉镜像，不会构建。里面包含 Discord bot、LINE bot、cloudflared 和 XHS-Downloader 四个服务。把它和 `.env` 放在同一个文件夹，拉取新镜像后重启容器即可。

### NAS 上的测试版

`compose.nas.dev.yaml` 和正式版的服务相同，但使用 `:dev` 镜像，容器名称都加上 `-dev`，可以和正式版同时运行。

- 放在 NAS 上**另一个文件夹**，`.env` 填测试 bot 的设置（就是 `.env.dev` 的内容），`CLOUDFLARE_TUNNEL_TOKEN` 用测试 tunnel 的 token。
- 测试 tunnel 的路由（`line-dev.yohaneowo.com` → `host.docker.internal:8787`）不需要修改：compose 让 LINE bot 容器使用 `host.docker.internal` 这个别名，同一条路由在电脑和 NAS 上都能用。
- **测试版在 NAS 上运行时，要关掉电脑上的 `npm run dev`**，因为两边用的是同一组测试 bot 的 token。
注册稳定版的 slash 命令：`npm run deploy`。
