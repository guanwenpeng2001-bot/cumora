# Docker 化部署(自托管,一条命令起全部)

仓库根的 `docker-compose.yml` 起四个服务:

| 服务 | 镜像 | 端口 | 说明 |
|---|---|---|---|
| db | pgvector/pgvector:pg16 | 5432 | 复用外部卷 `cumora-pgdata`(数据不丢) |
| redis | redis:7 | 6379 | 复用外部卷 `cumora-redis-data` |
| server | 本地 build(`server/docker/cumora-server.Dockerfile`) | 5181 | API + 调度器 + orchestrator;启动前先跑 `npm run migrate` |
| web | 本地 build(`deploy/web.Dockerfile`) | 8080 | nginx serve SPA dist,反代 `/api`、`/ws`(WebSocket)、`/uploads` 到 server |

## 前提

1. **`.env`** 在仓库根目录(gitignored)。compose 用 `env_file` 读入,再用 `environment:` 把 `DATABASE_URL` / `REDIS_URL` 覆盖为服务名(`db` / `redis`)——`.env` 里的 localhost 值是给宿主机 dev 用的,不用改。
2. **K8s(orchestrator 用)**:需要 Docker Desktop 内置 K8s(context `docker-desktop`)。容器内 kubectl 使用 `~/.kube/config-docker`——这是 `~/.kube/config` 的副本,把 server 改成容器可达地址并保留完整 TLS 校验:

   ```bash
   sed -E 's#server: https://127\.0\.0\.1:[0-9]+#server: https://host.docker.internal:58705\n    tls-server-name: kubernetes#' \
     ~/.kube/config > ~/.kube/config-docker
   ```

   注意:端口号(Docker Desktop 转发端口,如 58705)重启 Docker Desktop 后可能变化,变了就重新生成 config-docker 并 `docker compose up -d --force-recreate server`。apiserver 证书没有 host.docker.internal 的 SAN,`tls-server-name: kubernetes` 让 client-go 按证书里的 SAN 校验。
3. 宿主机 dev 进程(`npm run dev:all`)占用 5180/5181,起 compose 前先停掉。

## 日常操作

```bash
docker compose up -d                # 起全栈(首次会自动 build)
docker compose build                # 改了代码后重新构建镜像
docker compose up -d --build        # build + 重启受影响服务
docker compose logs -f server       # 看 server 日志(migrate 输出在最前面)
docker compose logs -f web db redis
docker compose down                 # 停掉所有容器(卷保留,数据不丢)
```

改了 `.env` 后(env_file 不会热加载):

```bash
docker compose up -d --force-recreate server
```

## 访问入口

- Web UI:<http://localhost:8080>(nginx,同源调 API,无 CORS 问题)
- API 直达:<http://localhost:5181/api/health>(容器内 server 的发布端口,OAuth 回调走这里)
- 宿主机 Vite dev(5180)仍可独立跑,与 8080 容器不冲突

## sub2api(LLM 订阅聚合网关,可选)

compose 里的 `sub2api` 服务从 fork [guanwenpeng2001-bot/sub2api](https://github.com/guanwenpeng2001-bot/sub2api) 构建(fork 补了 `POST /api/v1/admin/users/:id/api-keys`,让开通流程纯管理 API、不碰被 Turnstile 保护的 `/auth/*`)。数据库复用 cumora-postgres 里单独的 `sub2api` 库;Redis 复用 cumora-redis 的逻辑库 1;数据卷 `sub2api-data`。

- 管理后台:<http://localhost:8082>,账号 `admin@cumora.local`,密码是 .env 里的 `SUB2API_ADMIN_PASSWORD`
- 管理 API key:存于 sub2api 库 `settings.admin_api_key`,cumora 侧配在 `.env` 的 `SUB2API_ADMIN_KEY`
- tier 组:free / pro / max 三个组,组 id 配在 `.env` 的 `SUB2API_TIER_*_GROUP_ID`
- 重建镜像(拉 fork 最新 main):`docker compose up -d --build sub2api`

**自动开通只对部署之后的新注册用户生效**(oauth/waitlist 审批的 post-commit 钩子,失败自动回退 legacy 全局 key,不阻塞注册)。

**给存量账号手动开通(谨慎,有顺序要求)**:一旦写入 `sub2api_api_key`,该用户非前缀模型的 LLM 流量立刻改走 sub2api;如果对应 tier 组下没挂订阅账号,managed 大脑会全断。所以:

1. 先在 sub2api 后台(8082)给 free/pro/max 组添加订阅账号(账号 → 新增,Kimi/DeepSeek 等 OpenAI 兼容渠道)
2. 再跑:

   ```bash
   MSYS_NO_PATHCONV=1 docker compose exec server npx tsx server/src/scripts/provision-sub2api-user.ts <email> [free|pro|max]
   ```

   脚本会拒绝覆盖已有 key;要重置就先手动清 `users.sub2api_api_key` 再跑。

用量页(设置 → 用量)读 sub2api 订阅快照;未开通的用户显示"不可用"而不是报错。

## 已知限制

- `.env` 里 `PUBLIC_ORIGIN=http://localhost:5181`、`AUTH_DONE_URL=http://localhost:5180/` 是浏览器侧地址。如果从 8080 的容器化 UI 走 OAuth 登录,需要把 `http://localhost:8080/` 加进 `CUMORA_AUTH_RETURN_ALLOWLIST`,并把 `AUTH_DONE_URL` 指向 `http://localhost:8080/`(改完 `--force-recreate server`)。
- agent-computer pod 仍经 `host.docker.internal:5181`(宿主机发布端口)访问 server,无需改动。
- `.env` 绝不提交进 git。
