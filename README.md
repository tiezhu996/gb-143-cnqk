# 志愿者积分与信用评估

记录志愿服务、计算积分信用、处理投诉和生成排行榜的后端服务。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- 前端：http://localhost:8243
- 后端健康检查：http://localhost:3243/api/health
- 数据库端口：localhost:5743

停止并清理容器、网络和数据卷：

```bash
docker compose down -v --remove-orphans
```

## 主要功能

- 志愿者档案与服务记录
- **每日工时上限**：同一志愿者同一记录日期有效工时上限 8 小时，按当天录入顺序分配；
  超出部分标记为 `overtime`（超额），记录原样保留，不计积分、不增加服务次数和信用评价
- **撤销与补回**：撤销服务记录（标记 `revoked`，原记录保留）后，系统按当天顺序把释放出的
  有效工时额度补回后续记录，并重算积分、等级、徽章、服务次数与信用分
- 服务记录列表可查询每条记录的有效工时、超额工时、状态及每日重算结果（支持 `status`、`record_date` 过滤）
- 积分、徽章和信用分计算（爽约不占用当天工时额度）
- 投诉处理、后台调整和排行榜（趋势、排行仅统计有效工时与有效记录）

### 每日工时上限说明

| 记录状态 | 含义 | 积分 | 服务次数 | 信用评价 |
| --- | --- | --- | --- | --- |
| `valid` | 有效（含跨上限被拆分、仍有部分有效工时的记录） | 按有效工时计算 | 计入 | 参与评分 |
| `overtime` | 整笔超额（当天 8 小时已满） | 不计 | 不计 | 不参与 |
| `no_show` | 爽约（不占工时额度） | 扣 20 分 | 不计 | 计爽约惩罚 |
| `revoked` | 已撤销（记录保留可查） | 不计 | 不计 | 不参与 |

批量导入与单条补报使用相同规则；上限配置见
`backend/src/constants/serviceConfig.ts` 的 `serviceRules.dailyValidHoursLimit`。

## 本地开发

前端：

```bash
cd frontend
npm install
npm run dev
```

后端：

```bash
cd backend
npm install
npm run dev
```

无需本地 PostgreSQL 的业务测试（基于 pg-mem 内存库）：

```bash
cd backend
npm run test:daily-cap
```

数据库可通过根目录的 Docker Compose 单独启动：

```bash
docker compose up -d db
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Static HTML + Nginx |
| 后端 | Express + TypeScript |
| 数据库 | PostgreSQL |
| 部署 | Docker Compose + Nginx |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── .env
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
├── backend/
│   ├── Dockerfile
│   └── ...
└── database/
    └── ...
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| COMPOSE_PROJECT_NAME | Compose 项目名，避免中文目录名导致项目名为空 | gb-143 |
| DB_NAME | 数据库名称 | volunteer_db |
| DB_USER | 数据库用户 | volunteer_user |
| DB_PASSWORD | 数据库密码 | volunteer_pass |
| DB_ROOT_PASSWORD | 数据库 root/superuser 密码 | volunteer_root_pwd |
| JWT_SECRET | 后端签名密钥 | volunteer_credit_secret_key_2026 |
| FRONTEND_PORT | 前端宿主机端口 | 8243 |
| BACKEND_PORT | 后端宿主机端口 | 3243 |
| DB_PORT | 数据库宿主机端口 | 5743 |

## Docker 部署说明

- `docker-compose.yml` 顶层已声明 `name: gb-143`，可以在中文目录名下直接运行。
- 数据库使用 Docker 命名卷 `db_data` 持久化，不绑定到宿主中文路径。
- 前端容器使用 Nginx 托管静态资源，并将 `/api` 反向代理到后端服务名 `backend`。
- 后端会等待数据库健康后再启动，前端会等待后端健康后再启动。
- 如本机端口冲突，修改根目录 `.env` 中的 `FRONTEND_PORT`、`BACKEND_PORT` 或 `DB_PORT`。

## License

MIT
