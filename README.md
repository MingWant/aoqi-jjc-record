# 战皇档案

竞技场 Top 5 自动采集、周结算和名人堂候选统计服务。后台复用了游戏客户端的登录与 Socket 协议，不依赖 Flash 进程。

## 功能

- 使用专用账号执行 HTTP 登录并维持 TCP 游戏会话。
- 调用 `16_24_L`，分别采集经典和传奇竞技场各战区前五。
- 保存原始响应、采集快照和固化后的每周榜单。
- 提供类似电子表格的历史周榜补录，可直接粘贴 Excel 多行数据并覆盖修正；补录不保存战力。
- 经典竞技场周四 `21:00` 截止，传奇竞技场周四 `21:30` 截止；榜单在周五刷新后自动结算。
- 按玩家 ID 统计战皇席位、当前连皇和最长连皇。
- 按玩家 ID、联盟 ID 建立稳定身份档案；首次出现的游戏昵称/联盟名作为默认标注，后续改名只更新当前名称。
- 默认按“战皇数、最长连皇”确定候选；两项相同则并列。
- 支持当前赛季及固定三届周期汇总。
- 提供周榜、玩家履历、名人堂候选和采集状态网站。

## 运行环境

- Node.js `22.5` 或更高版本。
- 不需要安装 npm 依赖。SQLite 使用 Node 22 内置模块。

## 演示模式

```powershell
cd tracker
npm run demo
```

访问 `http://127.0.0.1:8787`。演示库位于 `data/demo.sqlite`，包含三届、两个竞技场、三战区的样例周榜。

## 正式配置

1. 将 `.env.example` 复制为 `.env`。
2. 设置专用小号登录信息：

```dotenv
ARENA_LOGIN_MODE=account
ARENA_ACCOUNT=多多号
ARENA_PASSWORD=明文密码
ARENA_ZONE_PREFERENCE=
```

用户名模式会先调用游戏现有的 `newUserQuery.jsp`：

```dotenv
ARENA_LOGIN_MODE=username
ARENA_USERNAME=用户名
ARENA_PASSWORD=明文密码
```

密码只在服务端内存中用于生成登录接口要求的 MD5，不会写入 SQLite、日志或浏览器响应。

启动：

```powershell
npm start
```

## 战区配置

[`config/arenas.json`](./config/arenas.json) 定义竞技场名称、协议参数、结算时间和战区显示名称。采集时以服务端 `zl` 数组实际返回数量为准；未配置的额外战区显示为 `战区 N`。

当前 H5 服务代码定义经典竞技场为希望、终湮、归墟三个战区，传奇竞技场为未来、造化、誓约三个战区。因此每周每个竞技场有 15 个战皇席位，两个竞技场合计 30 个。旧五战区口径保存在 [`config/arenas.legacy-5-zones.json`](./config/arenas.legacy-5-zones.json)。

## 周结算

- 每周周期为周五至次周四。
- 周四是结算归属日；按 H5 的每日刷新时间，默认在周五 `05:00` 读取更新后的战皇榜单。
- 普通时段默认每 5 分钟采集一次。
- 周五榜单刷新前 15 分钟默认提高到每 30 秒采集一次。
- 每轮采集按竞技场独立重试；一场失败不会丢弃另一场的成功结果。整轮结束后主动关闭游戏 Socket。
- 周五刷新后默认等待到 `06:00`，并确认各竞技场排名与上周不同，再将成功快照自动固化到前一天周四；点击“立即采集”也执行相同的自动统计。
- 少于“配置战区数 x 5”条记录的周榜标记为 `partial`；服务端临时少返回整个战区时也不会被误判为完整覆盖。
- 已经完整固化的周不会被后续轮询重复累计；更完整的快照可以升级 `partial` 周。
- 每天自动清理超过 30 天且未被周结算引用的快照；用于历史统计的结算快照永久保留。

采集间隔、稳定等待、快照保留天数和单场重试次数可在 `.env` 中调整，榜单刷新星期和时间可在 `config/arenas.json` 中调整。`ARENA_COLLECTION_RETRIES=1` 表示每个竞技场最多首次尝试加一次重试；`ARENA_SNAPSHOT_RETENTION_DAYS=0` 可关闭自动清理。

## 历史补录

网站“历史补录”页按所选竞技场生成三个战区、每区五名的固定表格。玩家 ID 和联盟 ID 支持从已有档案搜索选择，选择后会自动带出当前名称和稳定标注。也可以从 Excel 复制“玩家 ID、游戏昵称、玩家标注、联盟 ID、联盟现名、联盟标注”六列后粘贴到任意起始单元格；带表头的旧格式也会忽略战力列。

“保存并结算”会立即把该表计入战皇数和连皇统计，并同步更新身份档案。少于 15 个席位时会要求确认并保存为 `partial`；同一竞技场、同一结算周再次保存会替换该周采用的快照，历史快照仍保留。玩家档案表格中可以直接修改玩家标注，联盟备注则按联盟 ID 单独汇总编辑；同一联盟下的所有玩家会自动显示同一份备注，不需要逐个重复填写。玩家详情页也保留玩家标注编辑表单。

历史补录页默认打开“时间矩阵”模式：行是已有玩家，列是赛季内所有结算周，勾选表示该周进入前五席位。可以从玩家档案目录添加行、批量勾选多个周次后一次保存；未填满战皇席位的周次会保存为 `partial`。玩家档案页也可以先手动创建全新玩家身份，再从矩阵或详细周榜中补录。需要精确填写战区和名次时，可切换到“详细周榜”模式。

“名人堂候选”页也提供只读时间矩阵：可在“本届 / 三届周期”窗口之间切换，并查看每位候选人在各结算周的战皇记录；当前并列候选会用浅金色行标记。需要按战皇数和连皇数查看时可切换回“候选排行”。

## 赛季与名人堂

首次启动会按 `.env` 创建初始赛季。`ARENA_SEASON_END` 可直接指定结束时间；也可以填写 `ARENA_SEASON_WEEKS`，系统按最后一个竞技场结算截止时间自动计算结束时间。网站“系统”页可以新增或编辑赛季，填写计划周数时周数优先于手动结束时间；不填写周数和结束时间则为开放式赛季。

当前实现的连皇口径是“同一届竞技场内，进入任意战区前五的连续、已到期结算周数”。新一届开始时连皇会重新起算，跨届记录不会连接成一次连皇。候选排序为：

1. 战皇席位总数降序。
2. 最长连续周数降序。
3. 两项完全相同则共同成为候选。

当前 H5 服务代码从第 29 届起按固定三届周期合并，即第 29–31 届、第 32–34 届，之后依次类推，并非滚动“最近三届”。网站的“三届周期”只累计所选赛季所在周期截至该赛季已有的数据；例如选择第 32 届时只计入第 32 届。所有周榜均保存原始依据，官方口径变化时可以重新计算。

如果某个已到期的结算周完全没有记录，会作为缺失周插入时间轴并打断连皇；`partial` 周仍会统计已经明确录入的战皇席位，但页面会单独显示不完整周数。

## 管理安全

网站和统计 API 默认需要访问密钥；立即采集、手动固化、导入快照和赛季修改还需要管理密码。两把密钥可以设置成同一个随机值，也可以分开给普通查看者和管理员使用。

要允许进入网站并读取排行榜，设置：

```dotenv
ACCESS_TOKEN=一个足够长的随机值
```

要启用任何手动写入（创建玩家、修改备注、详细周榜补录、时间矩阵补录），必须设置：

```dotenv
HOST=0.0.0.0
ADMIN_TOKEN=一个足够长的随机值
```

服务端未配置 `ACCESS_TOKEN` 时，网站只显示锁定页，所有数据读取接口都会拒绝请求；自动定时采集仍可运行。未配置 `ADMIN_TOKEN` 时，手动写入接口会强制锁定。访问密钥在入口页验证，管理密码在网站“系统”页验证；两者只保存在当前浏览器的 `sessionStorage`。

## 主要 API

- `GET /api/bootstrap?season=32`：网站初始化数据。
- `GET /api/access/status`：检查是否已配置访问密钥（不返回密钥）。
- `POST /api/access/verify`：使用 `X-Access-Token` 验证访问密钥。
- `bootstrap.directory.players` / `bootstrap.directory.unions`：玩家和联盟身份档案目录。
- `GET /api/stats?season=32&arena=classic`：单届统计。
- `GET /api/hall?season=32&arena=classic&window=3`：三届周期候选。
- `GET /api/settlements?season=32&arena=classic`：周结算列表。
- `GET /api/settlements/classic/2026-07-09`：指定周榜。
- `GET /api/players/{playerId}?season=32&arena=classic`：玩家履历。
- `POST /api/admin/verify`：验证管理密码并解锁当前浏览器会话。
- `POST /api/admin/collect`：立即采集。
- `POST /api/admin/finalize`：手动固化周榜。
- `POST /api/admin/import`：导入排行响应或结构化榜单；传入 `finalize: true` 和 `weekKey` 可直接补录周结算。
- `POST /api/admin/matrix`：按时间矩阵批量补录多个结算周，传入 `{ arenaKey, seasonId, weeks: [{ weekKey, playerIds }] }`；玩家按已有档案 ID 识别，服务端会尽量保留原战区/名次，新增玩家填入空席位。
- `POST /api/admin/players`：手动创建玩家身份档案；传入 `playerId`，可选 `nickname`、`playerLabel` 和 `unionId`。
- `POST /api/admin/labels`：单独修改玩家标注或联盟标注。
- `POST /api/admin/seasons`：新增或编辑赛季；传入 `weeks` 可按计划周数自动计算 `endsAt`，传入 `endsAt` 可指定自定义周期。

除访问状态和验证接口外，所有 API 都要求 `X-Access-Token: <token>`；管理接口在此基础上还要求 `Authorization: Bearer <admin-token>`。

## 容器部署

```powershell
docker compose up -d --build
```

Compose 会固定在容器内监听 `0.0.0.0:8787`，并把数据库路径固定为 `/app/data/arena-tracker.sqlite`；`.env` 仍负责登录账号、管理密码和采集周期。SQLite 数据保存在 `arena-data` volume。备份时复制 `arena-tracker.sqlite` 及同目录的 `-wal` 文件，或在停止容器后复制数据库文件。

## 验证

```powershell
npm test
npm run check
```

测试覆盖 AMF3、消息序列、XT 包、登录响应、Top 5 解析、周历、连皇判定、SQLite 和 HTTP API。
