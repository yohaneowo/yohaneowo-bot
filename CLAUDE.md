# yohaneowo-bot

个人用的 Discord bot（`index.js`）和 LINE bot（`line.js`），Node.js + discord.js 14。功能：资产报告、链接解析（`services/media.js` 与 `services/sites/`）、动态语音频道、语音停留记录、电影推荐（`services/movies/`）。用户说明在 `README.md`。

管理后台是另一个 repo：**yohaneowo-admin**（`../yohaneowo-admin`，FastAPI + Vue）。bot 把群组、日志、资产、语音记录、依赖清单上报给它，见下方「与 admin 对接」。

## 工作约定

- 用中文回复。代码注释用英文，风格跟周围一致。
- 代码风格以 ESLint 为准（tab 缩进、`brace-style: stroustrup`），改完跑 `npx eslint .`。Prettier 跟 ESLint 冲突时听 ESLint。
- 用户用 SourceTree 管 git：只有被要求时才 commit / push。commit 讯息用中文摘要，结尾加 `Co-Authored-By`。
- 分支：`develop` 是测试版（测试 bot），`main` 是稳定版。发布稳定版 = 把 `develop` 快进合并到 `main`。
- `node_modules` 有一部分还被 git 追踪（历史遗留），**永远不要 stage `node_modules/.package-lock.json`**；也尽量不要装新套件，能用 `fetch` 直接调 API 就不加 SDK。
- `.env`（稳定版）、`.env.dev`（测试版）、`config.json` 有密钥：不要印出内容、不要 commit。要确认某个变量有没有设，只看「有没有值」。
- `data/`（动态语音、电影推荐、向量缓存）是 gitignore 的执行资料；Docker 里由 `bot-data` volume 保存。

## 常用指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 用 `.env.dev` 同时启动 Discord bot、LINE bot、XHS-Downloader 和 Cloudflare tunnel |
| `npm run deploy:dev` / `npm run deploy` | 注册 slash 指令（测试 / 稳定）。新增或修改指令定义后要跑 |
| `npm run docker:dev` / `npm run docker:release` | 用 buildx 构建并推 `:dev` / `:latest` 到 Docker Hub（`scripts/docker-publish.js`）|

改了程序要提醒用户重启 `npm run dev`；改了指令定义要提醒跑 deploy。测试时不要用正在运行的 bot token 另开一个实例。

## 与 admin 对接

- bot 端全部集中在 `services/adminApi.js`：`POST {ADMIN_API_URL}/api/v1/bot/internal/...`（依赖清单走 `/api/v1/project/internal/...`），请求头 `X-Bot-Token` = admin 的 `BOT_API_TOKEN`。
- 一律 best-effort：admin 挂了只记 warning，bot 照常运作。日志类（解析、运行、语音）进内存队列批量送，失败会重试；超出 `LOG_QUEUE_LIMIT` 丢最旧的。
- **AI 调用一律经过 `services/aiUsage.js` 的 `recordAiCall()`**（上报到 admin 的「AI管理 → AI调用日志」，admin 按单价表算费用）。替某人做事的流程包在 `withAiCaller({ platform, id, name, avatarUrl, trigger }, …)` 里，费用就算在那个人身上；多人共用的调用（例如新片的向量）用 `SYSTEM_CALLER`。新增任何调用 AI 的功能都要记录，失败的调用也要记（token 照样收费）。
- 栏位长度要跟 admin 的 Pydantic schema（`max_length`）一致，超长的在 bot 端先截断，否则整批被拒。`LOG_BATCH_SIZE` 对应 admin 的 `MAX_LOG_BATCH`。
- 环境分开：测试 bot（`.env.dev`）→ 电脑上的测试版 admin；稳定 bot（NAS，`compose.nas.yaml`）→ NAS 上的 admin（网络 `yohaneowo-admin`，网址 `http://yohaneowo-admin-web`）。**不要让两个 bot 上报到同一个 admin**，群组同步会互相覆盖。

### 新增一种上报（两个 repo 都要改）

1. admin：在 `backend/app/plugin/module_bot/<名称>/` 加 model / schema / crud / service / controller（含 `...InternalRouter`），生成并套用迁移，菜单加进 `sql/sys_menu.json` 再跑 `seed_menu`，前端加 API 和页面。细节见 admin 的 `CLAUDE.md`。
2. bot：在 `services/adminApi.js` 加函数（日志类就加进 `LOG_PATHS` / `logQueues`），在功能代码里调用。
3. 两边一起测：开一个临时 admin 实例（别动用户正在跑的那个），确认资料真的写进数据库，测完删掉测试资料。

## 多个对话同时工作

用户可能同时开着好几个 Claude Code 对话（这个 repo、admin repo）。

- 需要对接的功能，在同一个对话里把两边一起改完（另一个 repo 用 `/add-dir` 加进来），不要分开在两个对话各做一半。
- 同一时间只让一个对话改同一个 repo。开始改之前先看 `git status`：有不是自己做的未提交改动，就是别的对话正在改，不要覆盖，也不要把它们混进自己的 commit。

## 电影推荐（`services/movies/`）的已知结论

- 排名用规则（`taste.js`）。Voyage 内容向量（`embeddings.js`、`similar.js`）用真实资料实测过，排名没有比规则准，所以只用来给 AI 找「最像的历史作品」。
- AI 默认 Sonnet（`judge.js`）。Haiku 试过：会拿 TMDB 大众评分跟用户的个人平均分比较、漏挑重点影人，判断明显较差。
- 「预测你 X 分」是 AI 自己填的数字，没有校准过。
- 特殊版本（IMAX、4DX、ScreenX…）：IMAX、CJ 4DPLEX、IMDb 都挡程式，TMDB 也没有这类资料。所以 `wikipedia.js` 用 TMDB 的 Wikidata 编号找到英文维基条目，挑出提到版本的句子，交给同一次 Sonnet 判断（只能根据句子，不准凭记忆：候选片多半比模型的训练资料新）。上映提醒时，如果句子变了，就用 Haiku 重新读一次（`extractFormats`）。Wikimedia 请求要排队、间隔，太快会被挡。
