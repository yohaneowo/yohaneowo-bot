# 验证流程（改动 bot 后必须交出的证据）

适用：任何改动 yohaneowo-bot 的人或 AI。完成后先按本文跑检查、交证据，复核（Tess）才审。起因：YouTube Shorts 送出 0 bytes 空档，bot 当成功并删了使用者原讯息。

本文只描述验证，不是功能代码。「已核实」的内容都附日期与来源；「待确认」的没有查到，不要当成事实。

## 硬性限制

- 只在 `develop` 分支开发。推送、部署、合 `main` 要老板当次明说同意（历史上某次授权不延伸到下一次）。合 `main` 的常设例外（老板 2026-11-19，见 `CLAUDE.md` 的「分支」一条）：「反馈→重现→修复」流程里的 bot 修复，若 ① 已重现成功并留有证据（字节数、秒数、版本）、② 维护员_Tess 独立复核通过，上线稳定版不必再问老板；上线前通知秘书或 King（通知不是批准），部署闸门照旧。不适用：新功能（含反馈收件功能本身）、还没重现的防护性修改（仍要老板逐次点头）、别的项目。验证的人自己仍不合 `main`。
- 不碰 `prd`：不跑 `npm start`、`npm run deploy`、`npm run line`、`npm run docker:release`。
- 不向真实 Discord／LINE 发测试讯息，不删真人讯息，不读写真人资料。验证用单元测试和不发送的 fixture（假 message、假 `postMedia`、假 probe、假 fetch）。
- **不要另开第二个 bot。** `dev`（本机）与 `stg`（Coolify 上的测试 bot）是同一个 Discord 测试 bot 的 token（见 `CLAUDE.md`），本机 `npm run dev` / `dev:dc` 与 Coolify 同时跑会出现两个实例。要在真实 Discord 看效果，先问老板，或交给 Tess（push develop 后看 Coolify 上的测试 bot）。
- 不打印密钥。Doppler 只看变量名：`env -u PWD doppler secrets --only-names -p yohaneowo-bot -c <dev|stg|prd>`（Git Bash 要加 `env -u PWD`）。
- 证据里只贴站点域名，不贴完整私人连结。永远不要 stage `node_modules/.package-lock.json`。

## 已核实的指令与环境（2026-11-16，Windows 本机）

| 项目            | 结果                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试        | `npm test`（= `node --test "test/*.test.js"`）。2026-11-17 共 97 项：本机（Windows）92 通过、5 项跳过，dev 容器（Linux）97/97 通过。多数不需要 ffmpeg 或网络；`test/ytdlp-stub.test.js` 要 Linux 与 ffmpeg，本机会跳过，要在 dev 容器里跑（见下）                                                                                                                                                                                     |
| lint            | `npx eslint .`（`package.json` 没有 lint 的 npm script）。目前无错误。规则是 tab 缩进、`brace-style: stroustrup`                                                                                                                                                                |
| format check    | `npm run format:check`（= `prettier --check .`）。**目前 54～63 个旧档本来就不通过**（含已通过 ESLint 的新测试档；加 `--end-of-line auto` 仍有 54 个）。`AGENTS.md` 写明 Prettier 与 ESLint 冲突时听 ESLint，所以这条只记录、不当闸门；不要为它 `prettier --write` 重排整个旧档 |
| Doppler 配置    | 存在 `dev`、`stg`、`prd` 三个配置，`GUILD_ID` 等变数在三者都有；`dev`、`stg` 的 `GUILD_ID` 与 `prd` 不同（只比对了哈希，没有看到值）                                                                                                                                            |
| ffmpeg／ffprobe | 本机有（2023-08-28 build）；正式与 dev 容器也有（Tess 2026-11-16 验收记录）                                                                                                                                                                                                     |
| yt-dlp          | **本机没有**（`which yt-dlp` 找不到）。所以本机不能做真实站点下载。Coolify 上的 dev 容器有（2026-11-17 读到 2026.10.26），真实站点的解析检查要在那里做（见下「测试环境」）                                                                                                      |
| 测试版部署      | push `develop` → Coolify `yohaneowo-bot-dev`（Doppler `stg`）；push `main` → `yohaneowo-bot`（`prd`）。来源：`CLAUDE.md`                                                                                                                                                        |

## 测试环境（2026-11-17 已核实）

- dev 测试服务器：ID 见 Doppler `dev`／`stg` 的 `GUILD_ID`（不写进公开 repo）。老板 2026-11-17 确认过这就是专用测试服务器。
- 核对方式（2026-11-17）：用 `dev` 的 bot token 只读调 Discord REST `users/@me/guilds`，HTTP 200，测试 bot 只在 1 个服务器里，而且就是 `dev` 的 `GUILD_ID` 那个；`prd` 的 `GUILD_ID` 不是它。没有在任何服务器发讯息。
- 测试 bot 是 Doppler `dev`／`stg` 共用的那一个（见「硬性限制」）；真实站点解析在 Coolify 的 dev 容器里做，不要在本机另开 bot。
- 在这个服务器贴测试连结、让测试 bot 发讯息，仍要老板当次明说同意。

## 待确认（没有查到，别假装有）

1. **各站点的固定测试连结**：repo、README、Doppler 变数名里都没有，老板也还没批准固定哪些。在批准前，真实站点下载一律写「未实测」。（2026-11-17 已有一份提议清单交秘书，等老板选。）
2. 自动删原讯息规则（见下）目前**没有**自动测试；只有 Tess 在 2026-11-16 用不发送的 fixture 验过一次，fixture 不在 repo 里。

## 必跑（每次改动）

在 repo 根目录：

1. `npm test`：记下 tests／pass／fail 数。
2. `npx eslint .`：必须无错。
3. `npm run format:check`：只记录是否有**你改的档案**出现在警告里，不当闸门（见上表）。
4. `git status`：确认只有预期档案。

## 依改动范围追加（不必全跑）

| 改动范围                                                 | 要交的证据                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `services/sites/video.js`、`services/media.js`、任一站点 | 空影片契约（下）。有 ffmpeg 时用真档案：正常 mp4 通过，0 bytes 与乱码档被拒                                               |
| `services/mediaPost.js`、`services/adminApi.js`          | 失败时 `reportParse` 收到 `result=failed`，空档的 `error_message` 以 `empty_file` 开头                                    |
| `index.js` 自动处理（MessageCreate）                     | 删原讯息契约（下）                                                                                                        |
| `services/sites/linkhub.js`                              | `test/linkhub-gif.test.js` 通过：GIF 优先、失败回退 mp4；LinkHub 空档改走本机解析重试一次                                 |
| slash 指令（`/x`、「解析链接」）                         | 改了指令定义要提醒跑 `npm run deploy:dev`（只注册到测试 bot）；真实入口截图由 Tess／老板在测试 bot 上验，开发者不自己登入 |
| `services/sites/chain.js`、`deadline.js`、`video.js`（yt-dlp 参数）、`linkhub.js` 下载 | 空影片自动重试契约（下）：`test/fallback-chain.test.js`、`media-post.test.js`、`ytdlp-args.test.js`、`linkhub-multi-item.test.js`、`line-busy.test.js` 通过，**加上 dev 容器里跑 `test/ytdlp-stub.test.js` 的输出**（假 yt-dlp 的独立子进程测试） |
| `scripts/repro.js`、`scripts/repro-runner.js` | `test/repro.test.js` 通过，并在 dev 容器里用真实链接对 `--ref current` 与至少一个旧 SHA 各跑一次，贴出 JSON（密钥值不得出现在输出里）；这支脚本不能改成会上传、会读 `index.js` 或会带出环境变量 |

### 空影片契约（`test/empty-file.test.js` 已覆盖）

- 档案 < 10 KB（`MIN_VIDEO_BYTES`）或 ffprobe 读不到长度 → 丢 `EmptyFileError`（`code: EMPTY_FILE`，带 `userMessage`）。
- 测试覆盖：0 bytes、少 1 字节、刚好下限、正常档、读不到长度、ffprobe 不存在（ENOENT 不当坏档）。
- `services/media.js` 另有一层：任何站点结果出现 0 bytes 档就丢 `EmptyFileError`。
- 失败：状态显示失败、不算 posted。

### 空影片自动重试契约（`services/sites/chain.js`）

- 一个链接走一条固定的阶梯：LinkHub（设了才走）→ 站点自己的解析（Facebook 例外：本机 yt-dlp 影片 → LinkHub → 链接预览，顺序测试在 `test/facebook-order.test.js`）→（只有直接用 yt-dlp 的 YouTube、TikTok、B 站）再用 yt-dlp 的另一组参数跑一次：单档、偏小、不合并，YouTube 另换 `mweb` 客户端。阶梯只走一遍；`chain.js` 是唯一会「退回」的地方，别在别处再加退回。
- 只有「紧邻的上一层」以 `empty_file`（0 字节、小于 10 KB、ffprobe 读不到长度）失败，才触发新增那一层；空档之后又遇到别的错误（网络、超时……）不再换路，也不会被当成空影片报告。`VIDEO_TOO_LONG`、需要登录、不支持等一律不重试。每一层的结果都要过 0 字节检查，每个影片档再过 ffprobe：读得到长度，而且有视频流（只有音轨的 mp4 不算；没有 ffprobe 就不判断）。这个检查也在时间预算之内：卡住会被取消，预算用完之后才回来的结果不算成功；单一影片另有 10 KB 下限（`fitVideoToLimit`）。
- 每层在自己的子目录里跑，失败就整个删掉，下一层不会读到上一轮的 `video.*`。
- 每个链接总时限 4 分钟：第一层一定会跑，之后每一层都要求至少剩 45 秒才开始，不会因为前面用光时间而多给时间；到点时取消 LinkHub 请求、yt-dlp（杀进程）、ffprobe 和 ffmpeg 压缩。不看这个信号的步骤（Facebook、Instagram 的预览请求，X、Threads 自己的请求）靠各自的超时结束。时间用完时报的是超时（通用「解析失败」），不会当成空影片。
- 另一个下载名额也被占满时不跑新增层（Discord 由 `mediaPost.js`、LINE 由 `line.js` 各自把自己的名额数告诉 `chain.js`）。
- 站点熔断：同一站点 10 分钟内整条阶梯失败 2 次 → 之后 10 分钟不跑新增层；成功就重置。同一网址整条阶梯失败后 5 分钟内再贴，直接回「刚刚下载失败」，不再重跑；成功就解除。都在记忆体里，重启清零。 新增层因忙、熔断或没时间而被跳过时，阶梯没走完，这次失败**不计入**站点计数、也不开启链接冷却（用户可以马上再试）。
- 全部失败：状态显示失败、`postMedia` 回 `false`（原讯息不会被删）、`reportParse` 记 `failed`，`error_message` 形如 `empty_file: tried=local,local-alt; site_consecutive=1; …`。
- **已知取舍**：Facebook、Instagram 遇到空影片会静默改发预览封面，不进新增层；X、Threads、小红书各有自己的解析，也没有新增层（但它们的多媒体贴文里的影片现在也会被 ffprobe 检查，读不到长度就换到下一层）。`mweb` 客户端是 2026-11 在 yt-dlp 2026.10.26 上实测可用（`android_vr` 能列格式但下载失败），**升级 yt-dlp 后要重验**。

### 在 dev 容器里跑整套测试（含假 yt-dlp 集成测试）

不改容器里的 `/app`：把 `services`、`test`、`package.json` 打包送进容器的临时目录，`ln -s /app/node_modules`，在那里跑 `node --test test/*.test.js`（注意要用 glob，别用 `node --test test/`，会把 `test/helpers/` 当测试），跑完删掉临时目录。真实站点的解析检查（`downloadMedia`）也在容器里做，不发 Discord。

### 重现脚本 `scripts/repro.js`（只下载、只量测，不上传、不碰 Discord）

用途：同一条链接在「出事版本」和「develop」各跑几次，比较字节数、秒数、哪一层交的档，判断问题能不能重现（重现师_Reese 用的就是它）。

```
node scripts/repro.js <链接> --ref <SHA|current> [--max-bytes N] [--timeout 秒] [--min-free-mb N] [--source auto|git|github] [--pretty] [--keep]
```

- `--ref <SHA>`：bot repo 的某个提交（7～40 位十六进制，不收分支名）。脚本自己在暂存目录取出该版本：有 `.git` 就用 `git archive`，没有（dev 容器就是）就从 GitHub 的源码包下载（仓库是公开的，不用密钥）。依赖用的是现在这份的 `node_modules`（连结过去，不另装）；旧版本的 `package.json` 依赖和现在不同时，报告的 `notes` 会写明。
- `--ref current`：不取版本，直接跑脚本所在的这份。在 dev 容器里，这就是现在部署的 develop。
- 用完删暂存目录；被 `timeout`、Ctrl-C 或脚本自己的看门狗打断时，也会杀掉整棵子进程树再删（连 `kill -9` 留下的旧暂存目录，下次启动也会清掉 1 小时以前的）。`--timeout`（默认 300 秒）是整次的时限，取版本也算在内。
- 磁盘余量低于 `--min-free-mb`（默认 500）就不跑，退出码 3。

输出是一个 JSON（stdout），主要栏位：

| 栏位 | 意思 |
|---|---|
| `ok` | 有交出可用的档案（`result` 有值）；`false` 时看 `error`（空档、超时、解析失败……），这仍是一次有效的量测 |
| `version_sha`、`version_source` | 实际跑的版本（完整 SHA；`git`／`github`／`current`）。从 GitHub 读不到完整 SHA 时是你给的那个，`notes` 会说明 |
| `result.bytes_total`、`result.duration_sec`、`result.files[]` | 字节数、秒数（ffprobe 读的）、每个档案的名称／字节／长度／编码 |
| `result.layer`、`result.layer_source` | 哪一层交的档：新版本由 bot 自己回报（`reported`），旧版本从日志推断（`inferred`，只能分出 `linkhub`／`local`） |
| `content_id` | 链接里看得到的影片或贴文 ID；短链和分享码（b23.tv、fb.watch、`/share/`……）不展开，是 `null` |
| `downloads` | 这一次实际下载了几次：`linkhub`、`ytdlp`、`direct`、`total`，`via_linkhub` 标出有没有走 LinkHub；`linkhub_parses` 是 LinkHub 解析次数（不是下载）。重现师每张单最多 4 次下载，这里的 `total` 就是这一次的花费 |
| `elapsed_ms`、`error`、`notes`、`log_tail` | 耗时、失败原因、提醒、最后 30 行 bot 日志（已脱敏） |

退出码：0＝量测完成（链接本身可能失败，看 `ok`）；3＝没能开始（磁盘不足、找不到版本、缺 `node_modules`……）；64＝参数不对或不支持的链接；124＝看门狗；130／143＝被中断。除 0 以外，stdout 仍是 JSON，错误在 `script_error`。

在 dev 容器里跑（脚本部署到 dev 之后）：

```
docker exec -u node -w /app <dev 的 portfolio-bot 容器> node scripts/repro.js <链接> --ref <SHA>
```

- **不要用 `doppler run`**：脚本自己从 bot 主进程（`node index.js`，工作目录就是这个 repo）按名字只拷 `LINKHUB_API_URL`、`LINKHUB_API_KEY` 两个变量；`DOPPLER_TOKEN`、`TOKEN`（bot token）、admin、webhook 等一律不拷，也不会传给被量测的版本。在 Coolify 容器里这两个变量只在 bot 进程里，PID 1（docker-init）没有它们，只有 `DOPPLER_TOKEN`；脚本也会先看 PID 1，但只认这两个名字。
- 输出里任何环境变量的值都会被替换成 `[redacted]`；脚本不印环境、不加载 `index.js` 或 `discord.js`，不可能登入 Discord。被量测的版本在子进程里跑，只拿到 `PATH`、yt-dlp／ffmpeg／ffprobe 的路径、`XHS_API_URL` 和上面两个变量，临时目录指向暂存目录。
- 限制：只比对「交档的是哪一层」，不能指定只走某一层；`content_id` 只来自链接本身，所以 Facebook 分享连结「跳转后的 reel ID」目前量不到；旧版本的 `layer` 是推断的。

### 删原讯息契约（`index.js`）

只有同时满足才删：每个连结都 posted、讯息内连结数 ≤ 3 且全部被处理、讯息只有连结（`isOnlyMediaUrls`）、`message.deletable`。检查四种情况：只贴连结且成功→删；任一失败→不删；连结夹文字→不删；超过 3 条连结→不删。没有 fixture 时只能读码核对，证据里要写「读码、未执行」。

## 证据格式（放提交说明或 raw/inbox）

每项写：执行的指令、输出摘要（数字）、必要的日志行。分三块：**真实执行过**、**没测**、**已知限制**。不要把「已补防护」写成「根因已消除」。回报先讲结论，列改动档案、提交号、测试结果，并确认只在 develop、未推送、未部署。
