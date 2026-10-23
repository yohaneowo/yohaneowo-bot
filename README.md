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
  | X（Twitter） | 文字、图片（原图）、影片（选上限内最高画质）、多媒体贴文（最多 4 个），引用贴文会显示被引用的媒体；敏感内容以 Spoiler 发送。也接受 fxtwitter / vxtwitter / fixupx 链接 | X 嵌入推文用的 syndication 接口，不需要登录；拿不到时改用 yt-dlp |

  Threads 没有 yt-dlp 解析器，bot 直接调用 Threads 网页使用的接口（做法参考 [vxThreads](https://github.com/everettsouthwick/vxThreads)）。接口需要的查询 ID 和参数会随着 Threads 更新而改变，所以 bot 会从 Threads 的网页脚本中自动读取（贴文页引用的脚本，加上路由定义接口列出的脚本——2026 年 10 月起查询只在后者里），缓存 12 小时，查询失败时重新读取。

  需要压缩的影片，如果压缩后的视频码率会低于 700 kbps（10 MB 上限下大约 90 秒），就不发送，改为回复"影片太长，建议直接到原网站观看"。原片本来就在上限以内的影片不受影响。

  Facebook 的限制：拿不到影片文件（影片贴文只能显示封面），多图贴文只能拿到第一张，私人或仅好友可见的贴文会解析失败。

  Instagram 的限制：有年龄或受众限制的内容需要登录才能看，bot 不登录，所以只显示封面并标注"无法下载影片"。Instagram 对未登录的请求有频率限制，短时间内解析太多会被暂时挡住。

  小红书：App 分享出来的链接没有 `xsec_token`，网页版和 yt-dlp 都会被导到登录页。所以另外跑一个 XHS-Downloader 服务来取得笔记资料。它不需要登录，但没有 cookie 时影片只有 720p。NAS 上由 `compose.nas.yaml` 启动，开发时由 `npm run dev` 启动。

  X 的限制：年龄限制和锁帐号的贴文，嵌入接口不会给资料，只能靠 yt-dlp 尝试下载影片，通常也会失败。

  支持的网站列在 `services/media.js` 的 `SUPPORTED_SITES`，每个网站在 `services/sites/` 里有自己的处理函数。

- **动态语音频道**：管理员用 `/voice-hub` 建立一个限 1 人的入口语音频道（可用 `name:` 自定名称、`category:` 指定分类）。
  有人进入入口，bot 会在同一个分类开一个「<名字> 的频道」（不限人数，权限跟随分类）并把人移过去；这个频道没人后 10 秒自动删除。
  不需要入口时直接删除那个频道即可。入口和临时频道记在 `data/voice-hubs.json`，bot 重启后会继续管理，离线期间空掉的频道也会在启动后删除。

- **电影推荐**：先到 [yohaneowo.com/connect/discord](https://yohaneowo.com/connect/discord) 用 Discord 登录（已经用 Google 登录着的会直接把 Discord 关联上去），再授权 Trakt 帐号、选观影地区建立观影档案；然后在 Discord 用 `/movie subscribe` 开启每日推荐。另外 `/movie recommend` 随时可以随机推荐一部你没看过的电影（可选类型、年代、最长片长），每天 3 部（含「换一部」）；按「想看」会加进你的 Trakt 想看列表，按「看过了」会检查你有没有评分，没有就请你当场打分并写进 Trakt。每天早上 10 点（台湾时间）：
  1. 之前以「即将上映」推荐过、现在上映了的电影，加进今天的提醒；
  2. 该地区正在上映、还没判断过的电影，用规则（类型兴趣、评分偏好、喜欢的导演与演员、口碑、热门度）排出最合适的几部；
  3. 新出现的即将上映电影也一样排名；
  4. 两类各取前 6 部交给 AI（默认 Claude Sonnet）判断要不要推荐、写理由。每部候选会附上你看过的作品里最像的 5 部（含剧集，用 Voyage 内容向量找出）和片中你评价很高的导演、主演。
  5. 当天的结果合成一则私信（Discord 新版排版），每部片一块：海报、理由、上映日期等资料一行；如果推荐重点是你喜欢的导演或演员，会附上照片和你给过他们作品的评分。

  卡片上会标出这部片做过的特殊版本（IMAX、IMAX 摄影机拍摄、杜比影院、4DX、ScreenX、3D 等）。资料来自英文维基百科提到版本的句子，由 AI 判断哪些是正式发行的版本，不凭 AI 的记忆；维基没写的片（中小型片、很多亚洲片）就不显示。显示的是「做过这些版本」，不代表你所在的地区一定有上映。

  「💬 AI 怎么看」按钮：回答卡片上没有的内容（可能踩雷的地方、需不需要先看前作、影评与观众评价，以及导演和主演其他作品你给过的分数）。资料来自 TMDB（系列、观众评论）和维基百科的「制作」「评价」段落，AI 不凭记忆回答、不剧透；只有按的人看得到，同一部片 24 小时内再按会显示同一个答案，每人每天最多 20 次（`MOVIE_ASK_PER_DAY`）。

  看过的电影不会再推荐，只有一个例外：**重映**。你评过高分（9 分以上，且比你的平均分高 0.5 分以上）的电影重新上映时，会用 🔁 卡片通知你，理由就是你当初的评分，不经过 AI，也不占每日额度。
  按「看过了」时，会到 Trakt 查你有没有评分；没有的话会吐槽一下，并附上 Trakt 的评分链接（只有你看得到）。

  已上映和即将上映的推荐各自每天最多 3 部（`MOVIE_MAX_PER_DAY`），上映提醒不算在内。每部电影只判断一次，结果记在 `data/movies.json`。
  每部片底下有「想看 / 没兴趣 / 看过了」按钮（还没上映的没有「看过了」），之后的判断会参考；按了「没兴趣」或「看过了」就不会再提醒。
  其他指令：`/movie status`（订阅设定与最近推荐）、`/movie check`（马上检查一次，10 分钟一次）、`/movie unsubscribe`（只停止推荐，网站上的档案和统计保留）。要改 Trakt 帐号或地区，到网站的观影页改。
  admin 没设 `ANTHROPIC_API_KEY` 时只用规则判断，理由会比较制式；没设 `VOYAGE_API_KEY` 时 AI 少了「最像的作品」这份参考（AI 都经 admin 转发，key 在 admin）。
  内容向量只用来找相似作品，不用在排名：用真实的观看记录实测过，向量排名没有比规则准，但它找出的相似作品（同系列、同导演、动画的剧集版）很准。

## Discord 设置

### Intent（Developer Portal → Bot → Privileged Gateway Intents）

| Intent | 特权 | 何时需要 | 用途 |
|---|---|---|---|
| Guilds | 否 | 一直需要 | slash 命令、频道 |
| Guild Voice States | 否 | 一直需要 | 知道谁在哪个语音频道（动态语音频道） |
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
| 管理频道 | 动态语音：建立入口和临时语音频道、删除空频道 |
| 连接 | 动态语音：把人移进频道时 bot 本身要能连接那个频道 |
| 移动成员 | 动态语音：把进入入口的人移到新频道 |

权限在服务器里设置，不需要回 Developer Portal。bot 已经在服务器里的话，直接修改它的身份组即可。

### 邀请链接

把 `<CLIENT_ID>` 换成该 bot 的 Application ID：

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=17951760
```

`17951760` 包含上表全部权限。不需要删除原链接的话，用 `17943568`（不含管理消息）。
bot 已经在服务器里的话，不用重新邀请，直接在它的身份组加上「管理频道」「连接」「移动成员」即可。

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

tunnel 有两种模式，由 Doppler 的 `dev` 配置决定：

| `dev` 配置 | 公开网址 |
|---|---|
| 有 `CLOUDFLARE_TUNNEL_TOKEN` | 固定网址，例如 `line-dev.yohaneowo.com`，就是 `LINE_PUBLIC_URL`。在 Cloudflare 建一个测试用的 tunnel，Public Hostname 指向 `http://host.docker.internal:8787` |
| 没有 | 临时网址 `https://xxxx.trycloudflare.com`，每次启动都不同，自动当作 `LINE_PUBLIC_URL` 使用 |

> 测试版和稳定版要用**不同的 LINE channel**（和 Discord 一样分成两个 bot）。dev 脚本会改写 channel 的 Webhook URL，共用同一个 channel 的话，正式环境会被导到你的电脑。

`npm run dev -- --line-only` 只启动 LINE 的部分；`npm run dev:dc` 只启动 Discord bot。

## 环境变量

TMDB、Trakt、Anthropic、Voyage 的 key 都不在这里：电影功能的 TMDB / Trakt / Wikipedia 请求由 admin 代查（用量在 admin 的「接口管理 → 第三方接口」），Claude 与 Voyage 由 admin 的 AI 转发接口调用（记在「AI管理 → AI调用日志」）。Voyage 免费帐号每分钟约 1 万 token，新订阅者第一次要生成整份观看记录，可能要十几分钟。

放在 Doppler 的 `yohaneowo-bot` 项目：稳定版用 `prd` 配置，测试版用 `dev` 配置。npm 脚本都包在 `doppler run` 里；新电脑先 `doppler login`，再在本目录 `doppler setup`。

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
| `ADMIN_API_URL` | | yohaneowo-admin 后端的网址，例如 `http://localhost:8001`；设了才会把所在的服务器、群组、活动时间、解析与运行日志、资产快照和语音停留记录（谁在哪个语音频道待了多久）上报给后台 |
| `ADMIN_API_TOKEN` | | 跟 admin 的 `BOT_API_TOKEN` 填同一个值 |
| `MOVIE_AI_MODEL` | | 默认 `claude-sonnet-5-5`；想省钱可以改成 `claude-haiku-4-5-20251001`（判断较不稳定） |
| `MOVIE_EMBEDDING_MODEL` | | 默认 `voyage-3.5` |
| `MOVIE_CRON` / `MOVIE_TIMEZONE` | | 每天检查的时间，默认 `0 10 * * *`、`Asia/Taipei` |
| `MOVIE_MAX_PER_DAY` | | 已上映与即将上映各自每天最多推荐几部，默认 `3` |
| `MOVIE_LANGUAGE` | | TMDB 片名与简介的语言，默认 `zh-TW` |
| `DATA_DIR` | | 存放需要保留的资料（动态语音频道、电影推荐），默认是项目下的 `data/`。Docker 里是 `/app/data`，由 compose 的 `bot-data` volume 保存 |

> 测试版的 `PORTFOLIO_CHANNEL_ID` 和 `MASTER_ID` 建议留空或改成测试用的值，否则两个 bot 会重复发送日报和私信。

## 开发（测试 bot，`develop` 分支）

> 测试 bot 现在跟稳定版一样跑在 Coolify 上：push `develop` 就会自动部署 `yohaneowo-bot-dev`（Doppler `stg`，LINE webhook 在 `https://line-dev.yohaneowo.com/webhook`）。本机用下面的方式跑之前，要先在 Coolify 停掉 `yohaneowo-bot-dev`，否则同一个 token 会有两个实例。

本机需要 Node 22+、ffmpeg，以及带 curl-cffi 的 yt-dlp（TikTok 需要模拟浏览器，否则会被拦截）：

```bash
pip install -U "yt-dlp[default,curl-cffi]"
```

```bash
npm install
npm run deploy:dev   # 注册 slash 命令（只在新增或修改命令时需要）
npm run dev          # 使用 Doppler dev 配置启动 Discord + LINE（含 tunnel）
```

## 部署（稳定版，`main` 分支）

镜像发布在 Docker Hub：`yohane0w0/yohaneowo-bot`。yt-dlp 和 ffmpeg 已经装在镜像里。

同一个 Docker Hub 仓库用 tag 区分版本：

| tag | 内容 | 发布指令 | NAS 用的 compose |
|---|---|---|---|
| `latest` | `main`（稳定版） | `npm run docker:release`（在 `main` 分支执行） | `compose.nas.yaml` |
| `dev` | `develop`（测试版） | `npm run docker:dev`（在 `develop` 分支执行） | `compose.nas.dev.yaml` |

指令会用**当前工作目录的代码**来 build，所以执行前要先切到对应的分支。

NAS 上使用 `compose.nas.yaml`，它只拉镜像，不会构建。里面包含 Discord bot、LINE bot、cloudflared 和 XHS-Downloader 四个服务。同一个文件夹的 `.env` 只放两项：`DOPPLER_TOKEN`（Doppler `prd` 配置的 service token，容器启动时用它拿其余设置）和 `CLOUDFLARE_TUNNEL_TOKEN`（cloudflared 是官方镜像，读不到 Doppler）。拉取新镜像后重启容器即可；在 Doppler 改了值也要重启 bot 容器。

### NAS 上的测试版

`compose.nas.dev.yaml` 和正式版的服务相同，但使用 `:dev` 镜像，容器名称都加上 `-dev`，可以和正式版同时运行。

- 放在 NAS 上**另一个文件夹**，`.env` 填测试 bot 的设置（Doppler `dev` 配置的内容，`ADMIN_API_URL` 改成电脑的局域网地址），`CLOUDFLARE_TUNNEL_TOKEN` 用测试 tunnel 的 token。这个 compose 没设 `DOPPLER_TOKEN`，所以容器直接用 `.env`。
- 测试 tunnel 的路由（`line-dev.yohaneowo.com` → `host.docker.internal:8787`）不需要修改：compose 让 LINE bot 容器使用 `host.docker.internal` 这个别名，同一条路由在电脑和 NAS 上都能用。
- **测试版在 NAS 上运行时，要关掉电脑上的 `npm run dev`**，因为两边用的是同一组测试 bot 的 token。
注册稳定版的 slash 命令：`npm run deploy`。
