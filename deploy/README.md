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

## 已知限制

- `.env` 里 `PUBLIC_ORIGIN=http://localhost:5181`、`AUTH_DONE_URL=http://localhost:5180/` 是浏览器侧地址。如果从 8080 的容器化 UI 走 OAuth 登录,需要把 `http://localhost:8080/` 加进 `CUMORA_AUTH_RETURN_ALLOWLIST`,并把 `AUTH_DONE_URL` 指向 `http://localhost:8080/`(改完 `--force-recreate server`)。
- agent-computer pod 仍经 `host.docker.internal:5181`(宿主机发布端口)访问 server,无需改动。
- `.env` 绝不提交进 git。
