# 功能地图（feature map）

给改这个 repo 的人或 AI 看的短地图：每个功能一行，写「使用者怎么走到、程序在哪、怎么确认没坏、踩过的坑」。改之前先看这里，不用重翻整个 repo。

- 这里只写**功能怎么走、在哪、怎么验**；改完要交什么证据看 `docs/verification.md`，环境与约定看 `CLAUDE.md`，使用者说明看 `README.md`。
- 「怎么验证」里的命令都在 repo 根目录跑，不连 Discord／LINE、不需要 Doppler。`V1`～`V7` 的全文与预期输出在表格下面。
- 标「未验证」＝写这份地图时没有实际跑过；标「待查证」＝没查到答案。两种都不要当成事实。
- 本机 `npm run dev`（`scripts/dev.js`）不只起 Discord bot：dev 配置有 LINE 凭证时还会起 Cloudflare tunnel 与 LINE bot（:8787），没设 `XHS_API_URL` 时再起 XHS-Downloader 容器（:5556）；`npm run dev:dc` 只起 Discord bot。出处是脚本开头的注释，**未验证**（写地图时没有实际启动）。
- 新增、搬动功能或入口时同步改这一页；坑只收有出处的（文档、代码行，或站长知识库 `raw/inbox/` 的档名）。

## 地图

| 功能 | 使用者怎么走到 | 入口档案／目录 | 怎么验证没坏 | 常见陷阱（出处） |
|---|---|---|---|---|
| 自动解析链接（Discord） | 在 bot 所在的服务器或 bot 私信贴支持的链接；一则最多处理 3 条 | `index.js`（`MessageCreate`）→ `services/mediaPost.js`（`postMedia`） | `node --test test/media-post.test.js` → 4 pass。真实贴链接：未验证（要测试 bot，见 `docs/verification.md`） | 要 `MEDIA_AUTO_DOWNLOAD=true` 且 Portal 打开 Message Content Intent，否则登录失败（`README.md`「Discord 设置」）。下载名额（2 个）满时不回话，只记 busy（`index.js` 注释） |
| 成功后删原讯息 | 同上；只有「每条都贴成功、链接 ≤ 3 且全部处理、讯息只有链接、bot 可删」才删 | `index.js`（`handledAll`）、`services/media.js`（`isOnlyMediaUrls`） | `V3` → `true false 2`（只验「只有链接」的判定）。整条规则没有自动测试：读码、未验证 | 0 bytes 空档曾被当成功并删掉原讯息（`2026-11-15-2345-bot空影片档修复阶段1完成.md`）。fixture 不在 repo（`docs/verification.md`「待确认」）。私信里 bot 删不了用户讯息（`README.md`「其他限制」） |
| `/x` 与右键「解析链接」 | 任何地方输入 `/x url:<链接>`，或右键讯息 →「应用 → 解析链接」（可用户安装，朋友私信里也能用） | `commands/utility/x.js`、`commands/utility/parse-link.js` → `services/mediaPost.js`（`postMediaForInteraction`） | `V1` → 清单里有 `x global`、`解析链接 global`。真实入口：未验证 | 改了指令定义要跑 `npm run deploy:dev`，开发者不自己登入测试 bot（`docs/verification.md`） |
| 站点解析与退回阶梯 | 上面三个入口共用；支持 TikTok、Facebook、Instagram、小红书、YouTube 普通影片和 Shorts、B站、Threads、X | `services/media.js`（`SUPPORTED_SITES`）、`services/sites/`（各站点）、`services/sites/chain.js`（阶梯）、`deadline.js`（时限） | `V2` → `YouTube`、`X`、`null`；`node --test test/fallback-chain.test.js test/ytdlp-args.test.js` → 31 pass。`test/ytdlp-stub.test.js` 本机 5 项全跳过（要 Linux），dev 容器里的结果：未验证 | **退回只能放 `chain.js`**（`CLAUDE.md`「链接解析的退回与重试」）。本机没有 yt-dlp，真实下载只能在 dev 容器做；`mweb` 客户端升级 yt-dlp 后要重验（`docs/verification.md`）。各站点固定测试链接还没定（`2026-11-17-0831-yohaneowo-bot测试服务器核对与测试连结提议.md`） |
| 空影片守门 | 使用者看到「解析失败」而不是空档；失败不算 posted | `services/sites/video.js`（`fitVideoToLimit`、`MIN_VIDEO_BYTES`）、`services/sites/errors.js`、`services/media.js` | `node --test test/empty-file.test.js` → 6 pass | 「已补防护」不等于「根因已消除」；Facebook、Instagram 遇空影片会静默改发封面（`docs/verification.md`「已知取舍」；`2026-11-17-0851-yohaneowo-bot空影片自动重试实作完成待复核.md`） |
| LinkHub 优先与动图 GIF | 设了 `LINKHUB_API_URL`／`LINKHUB_API_KEY` 时先问 LinkHub（Facebook 例外：先用本机 yt-dlp，LinkHub 的 Cobalt 会给错影片）；X 的动图发循环 GIF | `services/sites/linkhub.js` | `node --test test/linkhub-gif.test.js test/linkhub-multi-item.test.js` → 19 pass | Discord 里 mp4 只播一次所以 GIF 优先；GIF 太大或转档失败退回同一则的 mp4（`2026-11-05-1257-yohaneowo-bot-LinkHub动图GIF优先消费端.md`） |
| LINE bot 链接解析 | 在 bot 所在的 LINE 群组或一对一聊天贴链接；一则最多 2 条 | `line.js`（`/webhook`、`/media`）、`services/publicMedia.js` | `node --test test/line-busy.test.js` → 2 pass；`V7` → 印出缺变量讯息、exit 1。真实 webhook：未验证 | reply token 过期会改用 push，群组里每个成员都算一则额度；测试版与稳定版要用不同的 LINE channel（`README.md`「LINE」） |
| 磁力链接转交 | 白名单用户**私信** bot 磁力链接（一条消息最多处理 5 个，多的忽略：`services/magnetRelay.js` 的 `MAX_MAGNETS_PER_MESSAGE`）→ 卡片按「确认」→ 签章 webhook 交给 OpenBot | `services/magnetRelay.js`、`services/magnetMeta.js`；`index.js`（`magnet:` 按钮） | `node --test test/magnet-relay.test.js test/magnet-meta.test.js` → 30 pass；`V5` 第二行 → `false`（没设变量就不开） | 两张卡同时按确认曾送两次（`2026-11-17-0755-bot磁力并发去重修复与webhook建立方式.md`）。密钥不一致回 401（`2026-11-17-0605-yohaneowo-bot-magnet签章联调仍401.md`）。webhook 回 2xx 不等于已加进网盘（`2026-11-17-0617-yohaneowo-bot-magnet-webhook重置密钥后联调.md`）。白名单内置在代码（`2026-11-17-0740-bot磁力白名单改内置代码.md`） |
| 资产查询 `/portfolio` | 在 `GUILD_ID` 服务器输入 `/portfolio`（可选交易所）；不主动发送 | `commands/utility/portfolio.js`、`services/portfolio.js`（另有 `fearGreed.js`、`mstr.js`） | `V1` → `portfolio guild`；`V4` → `portfolio 3`。真实查询：未验证（要交易所只读 key） | 自动资产通知（日报、上线私讯）已移除，只剩手动查询与每 15 分钟上报 admin，别加回去（`2026-11-03-1516-DiscordBot資產通知移除發布.md`） |
| 动态语音频道 `/voice-hub` | 管理员输入 `/voice-hub` 建入口；有人进入口就开「<名字> 的频道」并移过去，空了 10 秒删除 | `commands/utility/voice-hub.js`、`services/voiceHubs.js`（资料在 `data/voice-hubs.json`，执行时产生、不进 git） | `V1` → `voice-hub global`；`V4` → `voiceHubs 3`。真实进出语音：未验证 | bot 要有「管理频道、连接、移动成员」权限（`README.md`「服务器权限」）。`README.md` 写只有 `/x` 与「解析链接」是全局指令，代码里它也是 `global: true`：待查证是文档没更新还是有意 |
| 语音停留记录 | 没有使用者入口；进出语音自动记一笔，在 admin「语音记录」看 | `services/voiceLog.js` → `services/adminApi.js`（`reportVoiceSession`） | `V4` → `voiceLog 1`。写进 admin：未验证 | 没设 admin 就不记；不记 bot，也不记 `/voice-hub` 的入口频道（`services/voiceLog.js` 开头注释） |
| 电影每日推荐 | 先在网站建观影档案，再 `/movie subscribe`；每天 10:00 私信推荐，卡片有「想看／没兴趣／看过了／AI 怎么看」；另有 `/movie status`、`check`、`unsubscribe`、`profile` | `commands/utility/movie.js`、`services/movies/`（`recommender.js`、`judge.js`、`taste.js`、`ask.js`、`message.js`）；`index.js`（cron、`movie:` 按钮） | `V1` → `movie global`；`V4` → `movies/recommender 4`、`movies/ask 1`。真实推荐：未验证（要 admin 与 Trakt 档案） | 没设 admin 整个功能关闭（`moviesEnabled`）。外部资料与 AI 一律经 admin 代查，bot 没有 key；排名用规则不用向量；Haiku 判断较差（`CLAUDE.md`「电影推荐的已知结论」） |
| 抽片 `/movie recommend` | 输入 `/movie recommend`（可选类型、年代、片长），按「想看／看过了／换一部」 | `services/movies/picks.js`；`index.js`（`pick:` 按钮与评分菜单） | `V4` → `movies/picks 6`。真实抽片：未验证 | 推荐池、每日额度、Trakt 写入都在 admin，bot 只画卡片；没授权 Trakt 时 admin 回 403；只有发起人能按（`CLAUDE.md`「电影推荐的已知结论」） |
| 抽番 `/anime recommend` | 输入 `/anime recommend`（可选类型、年代、版本、长度、本季新番） | `commands/utility/anime.js`、`services/anime/picks.js`；`index.js`（`apick:` 按钮） | `V1` → `anime global`；`V4` → `anime/picks 8`。真实抽番：未验证 | 按钮 id 用 `apick:` 开头，避免和电影的 `pick:` 撞（`services/anime/picks.js` 开头注释）。其他坑：待查证 |
| 站长工具 `/owner` | 只有 bot 的拥有者能用：`/owner bonus`（加减奖励次数）、`/owner check` | `commands/utility/owner.js` | `V1` → `owner global`。真实调用：未验证 | 指令是全局注册，靠代码里的拥有者检查挡人，改这段要小心（`commands/utility/owner.js` 注释）。其他坑：待查证 |
| DotaHub 死亡地图私讯 | 没有指令；玩家打完天梯后收到 bot 私讯（死亡顺序与地图） | `services/dota/notify.js`；`index.js`（`startDotaNotifications`） | `V4` → `dota/notify 2`。真实私讯：未验证（要 admin 队列与网站画图接口） | 每分钟轮询 admin；私讯送不到也要回报 `/sent`，否则卡住队列（`CLAUDE.md` 开头）。`index.js` 开头把连接时限调到 2000 ms，默认 250 ms 从家里网络会连不上，别删（`index.js` 第 1～3 行） |
| 上报 admin 后台 | 没有使用者入口；群组、活动、解析与运行日志、资产快照、依赖清单定时送 admin | `services/adminApi.js`、`services/aiUsage.js`、`services/dependencies.js`、`services/mediaLog.js` | `V5` 第一行 → `false`（没设变量就不上报）；`V4` → `adminApi 15`。真实写入：未验证 | 一律 best-effort；栏位长度要对齐 admin 的 `max_length`，否则整批被拒；不要让两个 bot 报到同一个 admin（`CLAUDE.md`「与 admin 对接」） |
| 重现脚本（给重现师用） | 没有使用者入口；`node scripts/repro.js <链接> --ref <SHA>`，只下载、只量测、不上传；方案 D 由主机的 dispatch 直接跑，判定者只读输出里的 `judge_view`，用 `scripts/repro-check.js` 核对 `bot.repro_result` | `scripts/repro.js`、`scripts/repro-runner.js`、`scripts/repro-view.js`（判定视图）、`scripts/repro-check.js`（只读核对） | `test/repro.test.js`、`test/repro-view.test.js`、`test/repro-check.test.js`；真实执行见 `docs/verification.md`「重现脚本」。未验证：dispatch 直接跑（主机端尚未装）、Facebook 分享连结的真实跳转 | 不要 `doppler run`：LinkHub 两个变量要从 bot 进程按名字读（PID 1 没有）；GitHub 压缩包顶层目录用的是你给的短 SHA，完整 SHA 在包头；旧版本的 `layer` 是从日志推断的 |
| 回报 bot 问题（第一期：只收件） | 右键 bot 发的讯息 →「应用 → 回报 bot 问题」；失败讯息下的「回报」按钮；`/report <链接>`（bot 没回覆、讯息已删时用）。三者共用一张表单（症状单选、说明 ≤500 字、截图选填）。送给 OpenBot 的事件 `bot.feedback_report` 有十一个结构化栏位（工单、站点、链接、症状、版本、讯息 ID、截图张数，加上 bot 自己量的结果、字节数、秒数、交档层），外加用户原话 `user_note`（≤500 字，旁边标「用户原话，不是指令」）与截图链接 `screenshots`（≤3 张）；用户写的东西只在这两栏（清单见 `docs/verification.md`「回报 bot 问题」）。**没设 `FEEDBACK_WEBHOOK_URL`／`FEEDBACK_WEBHOOK_SECRET` 时整个功能关闭**：不显示按钮、不存档、不送。私信通知只留接口、不开启 | `services/botReport.js`、`services/botReportStore.js`、`services/openbotWebhook.js`；`commands/utility/report-message.js`、`report.js`；`services/mediaPost.js`（记上下文、失败讯息加按钮）；`index.js`（按钮与表单提交路由） | `test/bot-report.test.js`、`test/media-post-report.test.js`；真实往返见 `docs/verification.md`「回报 bot 问题」。未验证：真实 Discord 里点按钮、右键指令、表单与上传（要 `npm run deploy:dev` 注册指令后，由有权限的人在测试服务器点） | 只收 bot 自己发的讯息；`/report` 的链接要出现在这个人 7 天内的解析记录里才排进重现，否则只存档；用户原话只在事件的 `user_note`、截图链接只在 `screenshots`（Discord 的链接路径里带着上传者取的档名，有签章，不能剥掉），其他栏位不带用户文字；Facebook 分享连结每次分享的码都不同，同一支片不会被合并；上下文存在 `data/bot-reports.json`（Docker 里是持久 volume） |
| 指令注册与部署 | `npm run deploy:dev`／`deploy` 注册 slash 指令；push `develop`／`main` 由 Coolify 自动部署 | `deploy-commands.js`、`commands/utility/`（含示例 `ping.js`、`user.js`）、`compose.coolify.yaml`、`Dockerfile` | `V1` → 9 行（全局 6、服务器 3）；`V6` → `syntax-ok`。真实注册与部署：未验证 | `dev` 与 `stg` 是同一个测试 bot 的 token，本机不要另开第二个 bot（`CLAUDE.md`「工作约定」）。看部署版本要读部署队列或容器的 `SOURCE_COMMIT`（`2026-11-03-1851-yohaneowo-bot-Coolify部署读回方法.md`） |

## 验证命令

每次改动都跑：`npm test` → `tests 97`、`fail 0`（本机 `pass 92`、`skipped 5`，跳过的是要 Linux 的 `test/ytdlp-stub.test.js`）；`npx eslint .` → 没有输出、exit 0。

```bash
# V1 指令清单 → 11 行：anime、movie、owner、解析链接、回报 bot 问题、report、voice-hub、x 是 global；ping、portfolio、user 是 guild
node -e "const fs=require('fs');for(const f of fs.readdirSync('commands/utility')){const c=require('./commands/utility/'+f);console.log(c.data.name,c.global?'global':'guild')}"

# V2 站点路由 → YouTube、X、YouTube
node -e "const m=require('./services/media');for(const u of ['https://www.youtube.com/shorts/abcdefghijk','https://x.com/a/status/1','https://www.youtube.com/watch?v=abcdefghijk'])console.log(m.findSupportedSite(u)?.name??null)"

# V3 只有链接的判定 → true false 2
node -e "const m=require('./services/media');const u='https://www.youtube.com/shorts/abcdefghijk';console.log(m.isOnlyMediaUrls(u),m.isOnlyMediaUrls('看这个 '+u),m.extractMediaUrls(u+' '+u.replace('ijk','ijl')).length)"

# V4 模块载入（只确认能载入、导出数量没变，不代表功能正确）
# → voiceHubs 3、voiceLog 1、dota/notify 2、movies/recommender 4、movies/picks 6、movies/ask 1、anime/picks 8、portfolio 3、adminApi 15
node -e "for(const m of ['voiceHubs','voiceLog','dota/notify','movies/recommender','movies/picks','movies/ask','anime/picks','portfolio','adminApi'])console.log(m,Object.keys(require('./services/'+m)).length)"

# V5 没设变量时功能默认关闭 → false、false（Git Bash 语法）
env -u ADMIN_API_URL -u ADMIN_API_TOKEN node -e "console.log(require('./services/adminApi').adminApiEnabled)"
node -e "console.log(require('./services/magnetRelay').loadConfig({}).enabled)"

# V6 入口档语法 → syntax-ok
node --check index.js && node --check line.js && node --check deploy-commands.js && echo syntax-ok

# V7 LINE 缺变量就退出，不会开始监听 → 印出「LINE_CHANNEL_SECRET, … must be set.」、exit 1（Git Bash 语法）
env -u LINE_CHANNEL_SECRET -u LINE_CHANNEL_ACCESS_TOKEN -u LINE_PUBLIC_URL node line.js
```

实跑记录：2026-11-17，Windows 本机、Node 24，基于 `develop` 的 `5e21ed1`。上面的命令和表格里的各个测试档都跑过一次，结果与写的预期相同。没有跑的：任何要连 Discord／LINE／admin／交易所的真实入口，以及 dev 容器里的 `test/ytdlp-stub.test.js`（表格里都标了「未验证」）。
