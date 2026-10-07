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

  Facebook 的限制：拿不到影片文件（影片贴文只能显示封面），多图贴文只能拿到第一张，私人或仅好友可见的贴文会解析失败。

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

> 测试版的 `PORTFOLIO_CHANNEL_ID` 和 `MASTER_ID` 建议留空或改成测试用的值，否则两个 bot 会重复发送日报和私信。

## 开发（测试 bot，`develop` 分支）

本机需要 Node 22+、ffmpeg，以及带 curl-cffi 的 yt-dlp（TikTok 需要模拟浏览器，否则会被拦截）：

```bash
pip install -U "yt-dlp[default,curl-cffi]"
```

```bash
npm install
npm run deploy:dev   # 注册 slash 命令（只在新增或修改命令时需要）
npm run dev          # 使用 .env.dev 启动
```

## 部署（稳定版，`main` 分支）

镜像发布在 Docker Hub：`yohane0w0/yohaneowo-bot`。yt-dlp 和 ffmpeg 已经装在镜像里。

```bash
docker compose build
docker compose push
```

在 NAS 上使用只含 `image:` 的 compose（不含 `build:`），把 `.env` 放在同一个文件夹，拉取新镜像后重启容器即可。
注册稳定版的 slash 命令：`npm run deploy`。
