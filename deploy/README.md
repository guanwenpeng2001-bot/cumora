# Docker 自托管部署

**支持前提：纯 BYOA（不安装 Kubernetes）部署不在支持范围。** 即使主要使用 BYOA，也需要可用的 Kubernetes 集群、server 可访问的 kubeconfig 或 ServiceAccount、命名空间内 Pod/PVC 生命周期权限，以及用于安装预检/监控的节点读取权限。托管 agent 还需要可拉取的 agent-computer 镜像、节点 `/dev/fuse` 和 FUSE device plugin（`devic.es/fuse`）、可用 StorageClass，以及 Pod 到 runtime API 的网络连通性。server 依赖 PostgreSQL、Redis 与已执行的 schema migration；上传文件需要持久卷（单副本）或 R2（多副本）。

工作区 Pod/PVC 清理始终执行；公开旧开关 `workspace_runtime_cleanup_enabled` 已移除，历史 DB 行无需迁移。暂停 worker 使用 setting `workspace_cleanup_interval_ms=0`（启动环境变量为 `WORKSPACE_CLEANUP_INTERVAL_MS=0`），任务保留待处理，恢复间隔后重试。

基础层 `docker-compose.yml` 独立运行 Cumora。只有显式叠加 `docker-compose.gateway.yml` 才创建 sub2api 服务并要求网关引导凭据。以下命令中的 `config` 仅解析配置,不连接数据库、不运行迁移、不启动或重建容器。

## 服务与持久化身份

| 层 | 服务 | 容器名 | 端口 | 说明 |
|---|---|---|---|---|
| 基础 | db | cumora-postgres | 仅 Compose 网络 5432 | pgvector/pgvector:pg16;外部卷 `cumora-pgdata` |
| 基础 | redis | cumora-redis | 仅 Compose 网络 6379 | redis:7;外部卷 `cumora-redis-data` |
| 基础 | migrate | cumora-migrate | — | server 镜像;一次性执行 `npm run migrate` |
| 基础 | server | cumora-server | 5181 | API、调度器、orchestrator;等待 migrate 成功退出 |
| 基础 | web | cumora-web | 8080 | nginx SPA;反代 `/api`、`/runtime`（含 SSE）、`/ws`、`/uploads` |
| 可选网关 | sub2api | cumora-sub2api | 8082 | 本地 fork `../sub2api` 构建;保留原镜像标签与数据卷 |

基础层为五个服务定义(含一次性 migrate),叠加后为六个;正常长期运行的原五容器身份不变。项目名仍为 `cumora`,默认网络仍为 `cumora_default`,网关命名卷仍为 `cumora_sub2api-data`。如果既有部署通过 `-p` 或 `COMPOSE_PROJECT_NAME` 指定过项目名,所有后续命令必须继续使用同一值,以保留原网络及网关卷前缀。不要重命名已有网络/卷或更换项目名。本地附件另使用固定名称卷 `cumora-uploads`。

sub2api 继续复用 db 内独立的 `sub2api` 数据库及 Redis 逻辑库 1。基础 Compose 不负责创建该数据库;新环境需在另行授权的初始化步骤中准备,现有环境不重建、不修改数据。`server → migrate(service_completed_successfully) → db(service_healthy)` 的迁移门槛保持不变;server 还等待 Redis 健康。网关仅依赖 db/redis 健康,server/web 不依赖网关健康或启动成功。

## 前提和地址语义

1. 仓库根 `.env` 为本地私密配置,可参考 `.env.example`,绝不提交。Compose 从它读取插值,server/migrate 继续通过 `env_file` 接收运行配置;容器内 `DATABASE_URL` / `REDIS_URL` 仍由 Compose 覆盖为 db/redis 服务名。`--env-file` 只改变插值来源,不会替换服务的 `env_file: .env`。
2. 沿用外部卷和可用的 K8s 集群。`${KUBECONFIG_DOCKER:-${USERPROFILE:-${HOME}}/.kube/config-docker}` 挂到 server 的 `/root/.kube/config`,副本中的 API endpoint 必须从 server 容器可达。保留 CA 校验,需要时设置与证书 SAN 匹配的 `tls-server-name`;实际 endpoint/端口由部署填写。非 Windows 主机用 `KUBECONFIG_DOCKER` 显式指定该副本路径。
3. 浏览器入口、server 内部地址和 Pod 地址分别验证。`SUB2API_INTERNAL_URL` 是 server 的网关根 URL(不附 `/v1`),本 Compose 网络内可使用 `http://sub2api:8080`。实际值由 `.env` 提供,可选层不硬编码运行地址。
4. 当前 Pod URL 转换会把上述内部前缀替换为 `SUB2API_PUBLIC_URL`,因此该变量虽然名为 PUBLIC,也必须是 **Pod 可达的集群/内部根 URL**。Compose 服务 DNS 不自动跨入 K8s;不要给 Pod 仅在 Compose 内可解析的地址。优先使用 Pod 可达的内部服务或内部入口,避免带短请求超时的公网 Ingress。浏览器管理入口若另有地址,单独记录,不能拿它替代 Pod 可达性验证。
5. T36 启动快照及后续刷新沿用映射后的 gateway 地址与租户凭据;管理 key 不应传入 Pod。纯 env 的各 direct endpoint 同样必须从 server/Pod 可达。Pod 访问 Cumora server 的地址也需按实际集群网络核验。

## DB/Redis 密码与本地端口

基础层不发布 Postgres/Redis 宿主端口。宿主开发进程需要连接时，显式叠加开发文件；其绑定固定为 `127.0.0.1`，不会监听 `0.0.0.0` 或 IPv6 通配地址：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml config --quiet
# 同时使用网关：
docker compose -f docker-compose.yml -f docker-compose.gateway.yml -f docker-compose.dev.yml config --quiet
```

后续启动时也须使用相同文件列表。可在 `.env` 设置 `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT`（默认 5432 / 6379）；这两个变量仅影响开发叠加文件。容器间始终使用 `db:5432` / `redis:6379`。移除开发叠加文件后，下次应用配置将取消宿主端口发布；依赖原宿主地址的外部客户端需先迁移。

`.env` 必须设置非空 `POSTGRES_PASSWORD` 和 `REDIS_PASSWORD`，缺失或空值会使 `compose config` 失败。`.env.example` 中的 `cumora` / `cumora-redis-dev` 仅为本地开发示例，不是 Compose 回退值。部署时分别生成独立随机密码，例如运行两次 `openssl rand -hex 32`。当前 Compose 将原始密码拼入连接 URL，不自动做百分号编码，因此密码使用 URL 非保留字符 `A-Z a-z 0-9 - . _ ~`，推荐 64 位十六进制；不要使用 `@ : / # % $` 或空白。不要仅对密码变量做 URL 编码，否则数据库原始密码与 URL 解码后的密码可能不同。

Postgres 初始化、server/migrate 的 `DATABASE_URL` 和 sub2api 的 `DATABASE_PASSWORD` 共用 `POSTGRES_PASSWORD`。Redis 启用 `requirepass`，健康检查通过 `REDISCLI_AUTH` 认证并检查 `PONG`；server 的 `REDIS_URL` 使用逻辑库 0，sub2api 的 `REDIS_PASSWORD` 使用相同密码并保留逻辑库 1。migrate 不使用 Redis。宿主运行的 server/脚本需自行同步 `.env` 中的 `DATABASE_URL` / `REDIS_URL` 密码与开发端口，示例见 `.env.example`；不要依赖所有 dotenv 加载器都会展开嵌套变量。Shell 同名变量优先于 `.env`，改密前应清除旧的覆盖值。

## 已有卷升级：用户需手动执行的改密步骤

**修改 `POSTGRES_PASSWORD` 不会修改已有 `cumora-pgdata` 卷中的角色密码。必须对现有实例执行 `ALTER USER`，不能通过删除或重新初始化卷来改密。** 以下操作仅供用户在维护窗口手动执行，本次配置修改和静态校验不执行它们。

1. 备份数据库、私密配置及 sub2api 的 `/app/data/config.yaml`，保留原部署文件列表、项目名、镜像与卷。记录所有使用 `postgres` 角色或 Redis 的客户端（包括宿主进程及网关）。暂停相关客户端写入，安排连接中断窗口；不要先重建仍带旧密码的客户端。
2. 准备两个新密码。通过现有管理员访问方式连接当前 Postgres，例如 `docker exec -it cumora-postgres psql -U postgres -d postgres`。此命令使用容器内 Unix socket；若既有认证策略要求凭据，使用现有凭据或已有管理员连接，不要放宽认证。
3. 在交互式 psql 中执行 `\password postgres`，按提示输入两次新的 `POSTGRES_PASSWORD`。这是 psql 安全交互的角色改密入口，会执行对应的 `ALTER USER postgres WITH PASSWORD '新密码';` 操作，避免把明文密码写入命令行或 SQL 历史。不要直接复制含占位符的 SQL。`cumora` 和 `sub2api` 使用同一角色，因此只需改一次；旧连接可能仍存活，必须用新连接验证。
4. 将相同的新 Postgres 密码和独立的新 Redis 密码写入仓库私密 `.env`，同步宿主客户端的两个 URL，检查 shell 没有旧值覆盖。既有 sub2api 数据卷可能保存旧密码：同步其 `/app/data/config.yaml` 中 `database.password`、`redis.password`（如存在），保留其余配置；当前 fork 支持环境变量覆盖，但仍应核对实际部署镜像的行为，避免以后移除环境变量时恢复旧凭据。
5. 使用原项目名和完整文件列表执行 `docker compose ... config --quiet`（将 `...` 换成实际 `-f` 参数），通过后在维护窗口按新配置重建 db/redis 与相关客户端，保留原卷。Redis 密码来自启动参数，已有 Redis 卷无需 SQL 改密；必须重建 Redis 才能应用 `requirepass`，仅 restart 不更新容器配置。无需执行 `CONFIG SET` / `CONFIG REWRITE`。server 仍须经过 migrate 成功退出的门槛；启用网关时同步更新 sub2api。
6. 验证 Postgres 通过 TCP 使用新密码建立连接成功、旧密码被拒绝（socket 或 `pg_isready` 不能证明密码已更新）；验证 Redis 无认证被拒绝、新密码 `PING` 返回 `PONG`，以及 server、migrate 和启用时的 sub2api 均正常连接。可通过 `docker exec -it cumora-redis redis-cli --askpass ping` 交互验证 Redis。基础层应无 DB/Redis 宿主监听，开发层只应监听 `127.0.0.1`。检查历史数据仍在，保留备份直到验收完成。

如需回退，Postgres 角色密码不会随 Compose 文件回退；需通过仍可用的管理员连接再次交互改密，并同步所有客户端配置。Redis 的认证配置也要与客户端一起应用，不能只恢复旧 URL。不要删除卷，不要使用 `down -v`。

## 形态一:纯 env 独立运行

在 `.env` 和 shell 中清除全部 `SUB2API_*`,仅选择基础层。按所需能力提供真实 direct 配置:文本 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`,以及独立的 image、audio、embed 参数;Novita、OrcaRouter、DashScope 可继续使用既有配置。只配置实际使用的能力,不填写 dummy key。

```bash
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml config --services
```

预期只列出 db、redis、migrate、server、web,不要求任何网关密码。地址和 key 配置可解析不代表模型协议或账号能力已通过实测。

## 形态二:纯网关

始终按基础层在前、网关层在后的顺序使用两个文件。在 `.env` 填写:

- `SUB2API_ADMIN_PASSWORD`、`SUB2API_JWT_SECRET`、`SUB2API_TOTP_ENCRYPTION_KEY`:可选层的三个必填引导变量。现有部署保留原值;新环境使用独立强随机机密。
- `SUB2API_INTERNAL_URL`、`SUB2API_PUBLIC_URL`:按上述 server/Pod 网络语义填写。
- `SUB2API_ADMIN_KEY`:通过合法管理流程获得的管理 API key,用于用户开通及管理调用。
- `SUB2API_TIER_<FREE|PRO|MAX>_GROUP_<PLATFORM>`:已配置平台分组,PLATFORM 支持 sub2api 全部组平台(OPENAI/KIMI/DEEPSEEK/GROK/ANTHROPIC/GEMINI/ANTIGRAVITY/ZHIPU/MINIMAX/COMPOSITE),新增平台零代码。只给显式映射的平台铸 key。兼容变量见 `.env.example`,实际组类型和额度沿用已授权配置。
- 图片主控和目录 scheduler 变量:见下节。

Cumora 的 provider API key 留空,包括 `OPENAI_API_KEY`、`OPENAI_IMAGE_API_KEY`、`OPENAI_AUDIO_API_KEY`、`OPENAI_EMBED_API_KEY`、`NOVITA_API_KEY`、`ORCAROUTER_API_KEY`;凭据保留在网关账号和受管租户身份中。角色模型和协议仍需配置,网关目录可见不等于账号已获能力授权。

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.gateway.yml config --services
```

预期在五个基础服务之外增加 sub2api。缺少任一引导变量时应明确解析失败,基础层不受影响。管理员初始邮箱仍为 `admin@cumora.local`,管理入口为宿主机发布的 8082 端口。各平台账号、分组及开通状态先准备完成,再做模型链路验收;开通失败由持久同步意图重试,不把它当作自动使用全局 key 的承诺。存量账号补开通属于独立运维动作,不要在配置验证中执行。

注意:显式使用 `-f` 文件列表时,Compose **不会**自动叠加 `docker-compose.override.yml`。本机网络 workaround(DNS/MTU/skillhub 等,已 gitignore)若需要生效,必须显式追加为最后一个 `-f`:

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml -f docker-compose.override.yml config --quiet
```

反之不带 `-f` 直接 `docker compose up` 时,override 会被自动叠加,但它不应声明基础层没有的服务名。sub2api 的 DNS / extra_hosts 已移入 gateway 层；已有本机忽略文件应删除 `services.sub2api` 整段，保留 server、网络和挂载设置。基础加 override、基础加 dev 加 override 与裸 `docker compose config --quiet` 均应独立成功。

## 形态三:网关 + env 后备

使用与纯网关相同的两个 Compose 文件、网关身份和服务拓扑,再为允许后备的角色配置独立 direct key、endpoint、模型和协议。凭据填写本身不会开启后备。

`env_after_chain` 已落地:后备不是独立 env 开关,而是在 `CUMORA_LLM_CONFIG`(JSON,与站点设置 `llm_config` 同源)中给角色设置 `fallbackPolicy: "env_after_chain"` 并提供 `directTargets`。最小样例:

```json
{"roles":[{"role":"brain","fallbackPolicy":"env_after_chain","directTargets":[{"platform":"dashscope","model":"qwen3-max"}]}]}
```

启用后,只有网关候选耗尽且符合降级分类时才走 direct;关闭策略或缺少有效 direct 凭据时应明确失败。Cumora 自身认证/授权失败不能触发外呼,embedding 不使用自动模型或出口降级。direct 请求应记录在 Cumora 用量台账,不计入 sub2api 扣费。

## 图片主控与目录调度注入

| 变量 | 注入对象 | 值与生效约束 |
|---|---|---|
| `SUB2API_IMAGES_MAIN_MODEL` | sub2api | 图片工具的文本主控,不同于图片输出模型;使用 `${VAR:-}` 空默认,不内置具体模型名 |
| `UPSTREAM_MODEL_SYNC_ENABLED` | sub2api | `true` / `false`;关闭只影响后续任务,不抢断在途同步 |
| `UPSTREAM_MODEL_SYNC_INTERVAL_HOURS` | sub2api | 正整数小时,校验 duration 上界 |
| `UPSTREAM_MODEL_SYNC_ACCOUNT_TIMEOUT_SECONDS` | sub2api | 正整数秒,校验 duration 上界 |

四项均从部署 env 以空默认透传。图片主控留空可能进入上游代码回退,**不代表通过上线验证**;T47 使用实际账号验证生成、编辑、带图编辑和 usage 后再填写。镜像沿用现有固定 fork 标签;标签不能证明包含新源码,T47 发布时须以实际提交或 digest 定位,并核对图片功能、前端和静态价格资源,不能仅修改 VERSION。

scheduler 的优先级为 sub2api DB 设置 → env → 当前值。环境变量的数字分别以小时/秒为单位,管理设置里的 duration 表达遵循 T43 校验。空 env 不是关闭开关:当前解析会产生配置诊断并保留当前值,启用网关前应明确填写三项。DB 已保存的值优先于 env;管理设置更新只重设后续 timer。修改 Compose/env 不会热加载到既有容器,须在后续获准的服务更新窗口应用。

## 既有部署更新、验证与回退

已有网关部署从现在起必须始终使用两个 `-f` 参数,包括后续获准的构建、更新、日志及配置检查。保持原项目名、环境机密、镜像身份与卷;不要仅用基础层配合 `--remove-orphans`,不要执行 `down -v`、删除卷或重建整个环境。选择文件本身不会变更当前运行容器。

配置检查优先用 `config --quiet` / `config --services`,避免输出展开后的真实机密。隔离验证应使用临时目录中的 Compose 副本和 fake `.env`,同时清理 shell 的网关/provider 变量;不能仅给 `--env-file` 传空文件却仍从仓库 `.env` 读取服务机密。

Compose server 容器探针只请求 `/api/health`，由应用共享 PG/Redis 客户端执行有界 readiness 检查。K8s 的 startup/liveness 仍使用只检查进程响应的 `/api/livez`，readiness 使用 `/api/health`。两者都不把网关可用性当作硬就绪条件，网关故障不会阻断 `.env` 直连兜底入口。

后续发布先完成源码/制品和 schema 兼容核验,再按获准窗口应用目标服务。server 启动必须继续等待一次性 migrate 成功,失败时先查迁移日志,不能绕过门槛。回退恢复原文件组合、固定镜像及运行值;保留原卷、账号、session 和数据库,数据库回退遵循 schema gate,不删历史迁移或改 checksum。本次配置实施不启动、停止或重建任何容器。

## 浏览器与 OAuth

Web 发布端口为 8080,API 为 5181;外部实际域名由部署填写。若通过容器 Web 登录,把浏览器入口加入 `CUMORA_AUTH_RETURN_ALLOWLIST`,并将认证完成地址指向该 Web 入口。独立前端需要相应 CORS 配置;Pod 内部地址和浏览器 OAuth 地址不能混用。宿主机已有进程占用端口时先安排独立运维窗口,不要在配置解析任务中停止它们。


## 本地 uploads 持久化与旧容器升级迁出

四个核心 R2 变量未全部配置时，server 使用本地存储。本地存储必须持久化；基础 Compose 将命名卷 `cumora-uploads` 挂到 `/app/server/uploads`，与镜像 WORKDIR 和 storage.ts 一致。附件、头像及其子目录都在此处，数据库与 Redis 卷不能保护这些文件。其他部署（包括 Kubernetes）必须提供存储目录的持久挂载或完整对象存储配置；多副本本地存储需要共享持久存储。生产启动会提示持久化要求，但提示不能检测底层卷是否真正耐久。

**已有容器必须先迁出文件，再应用新增卷。** 新空卷会遮住旧容器可写层的 uploads；不要先重建 server，也不要依赖 Docker 自动复制旧容器数据。以下为后续维护窗口的操作顺序，本次源码修改不执行这些动作：

1. 保留旧 server 容器和准确镜像 digest，备份数据库及现有 uploads。暂停上传、头像生成和存储 GC 等写入，完成最终一致性复制。
2. 将旧容器的整个 `/app/server/uploads/.` 复制到独立备份目录（例如 `docker cp cumora-server:/app/server/uploads/. <backup-directory>`）。保留目录结构和文件名，核对文件数量、大小及校验和；空目录或复制失败必须先查清，不能继续重建。
3. 创建或确认固定名称的 `cumora-uploads` 卷。若卷已存在，先备份并检查内容，禁止盲目覆盖。通过单独的临时工具容器，将备份目录只读挂载并复制到该卷根目录，保留权限，确认 server 运行用户可读写。不要嵌套成 `uploads/uploads`。
4. 在应用新挂载之前，从卷读回核对同一组校验和。保留卷外备份；随后才在维护窗口按原 Compose 文件组合更新 server。不要执行 `down -v`（上传卷为 Compose 管理卷，可能被删除），也不要删除旧容器直到恢复验收完成。
5. 验证历史附件和头像 URL、新上传和下载，再安排一次受控 server 重建，确认新旧文件仍可读。保留备份直到升级验收及回退窗口结束。卷提供持久化，不替代备份。

同源网页生成的 BYOA 配对命令使用当前 HTTP(S) 页面 origin。使用 localhost、127.* 或 ::1 打开的页面会提示：另一台机器的 loopback 指向它自己，应先使用远程机器可达的域名或局域网地址打开网页，再生成命令。显式 server 配置和开发 API target 优先于页面 origin。nginx 的 `/runtime/` 同时转发普通请求及 wake-stream，关闭响应缓冲并配置 3600 秒读写超时。

## 发布前的 schema 回退预检

候选迁移先于 Deployment 更新，故 `kubectl rollout undo` **只恢复镜像/模板，不恢复数据库**。旧 Pod 迁移后仍在运行也不能证明旧镜像能重新启动。保留 schema gate、不可变迁移历史及 checksum；不要删除 gate 或为通过预检而扩大版本范围。

迁移前，从准确回滚镜像所对应的制品/源码取得 `server/src/db/migrations/manifest.ts`，记录镜像 digest，并运行离线预检：

```bash
node scripts/rollback-precheck.mjs <rollback-image-manifest.ts>
```

第二个可选参数为准确候选镜像的 manifest 路径（workflow 必传）；省略时读取本仓库候选 manifest。预检比较候选目标 schema、回滚支持范围及完整迁移元数据，不连接数据库、不运行迁移。缺少证据或范围不兼容时打印警告并以 1 退出；范围兼容只代表静态必要条件通过，仍会提醒核验 ledger/checksum 和业务兼容性。Deploy workflow 已在迁移前提取候选及准确旧 digest 镜像内的 manifest，自动检查范围和完整迁移元数据一致性；不是读取 checkout 来猜测候选版本。无 digest、证据缺失、版本不兼容或 ledger/checksum 不一致都会禁用自动回滚。smoke 失败时再次预检，仅 undo 到已记录的具体 revision；若 Deployment 已被其他发布改变则拒绝 undo。

发布验收还必须在隔离环境验证“准确回滚镜像 × 候选迁移后的数据库”，包括旧镜像重新启动的 schema gate 和关键读写。当前 `server/src/db/migrations/manifest.ts` 的支持范围严格为 **18–18**。自动回滚仅支持相同迁移历史及兼容范围的代码回退；跨 schema 回退/降级不受支持。每次必须重新读取制品，不能复用版本数字或仅比较标签。

若无通过验证的回滚制品，发布方案应明确采用向前修复，不得承诺 undo 能恢复服务。可选长期策略为经过验证的扩展/收缩迁移兼容窗口，或构建兼容新 schema 的专用回滚制品；本次不扩大 manifest 支持范围，不做数据降级或自动数据库恢复。范围与 checksum 通过不等于旧业务逻辑已经在新数据上验证。数据库备份恢复涉及停写及备份之后的数据损失，不能当作镜像回退自动执行。


## 自有服务器与 fork 发布坐标

托管 agent Pod 的 API server 必须在生产显式设置 `CUMORA_AGENT_COMPUTER_IMAGE`，指向包含本 fork 代码的不可变 tag 或 digest。未设置或空白时，orchestrator 会 warn 并使用本地约定 `cumora-agent-computer:dev`，不再使用上游 quay 镜像。该默认仅用于开发：需自行构建并将镜像加载到每个目标 Kubernetes 节点；`IfNotPresent` 在节点缺图时仍可能尝试默认 registry，tag 本身不保证离线。Compose 不负责构建该 agent 镜像，生产缺 env 不属于完成部署配置。

GitHub 发布坐标由 `CUMORA_GITHUB_OWNER` / `CUMORA_GITHUB_REPO` 覆盖，空值默认保持 `guanwenpeng2001-bot/cumora`。Electron 构建与 Vite 前端构建使用构建环境变量；API server 在启动环境中配置相同值，用于查找 CLI Releases。自有仓库需提供对应 CLI tag/tgz 和桌面更新制品；更换坐标不会自动复制 Releases。变量需注入实际构建或 server 进程，仅写宿主机 `.env` 不保证传入容器。详见 `docs/RELEASE.md`。

BYOA 首次配对命令应带 `--server https://<your-server>`，同源网页生成的命令已显式带入地址。daemon 的优先级为显式参数 → 本地配对配置 → 运行时 `CUMORA_SERVER_URL` → Release 构建时 bake 的 `CUMORA_DEFAULT_SERVER`；全部缺失则报错退出。CLI Release workflow 可从同名 repository variable bake 默认服务器，未配置时不内置上游地址。


## 部署健康与共享存储检查

GKE 多副本模板显式设置 `CUMORA_REQUIRE_R2=true`，并用非可选 Secret key 引用四个核心 R2 变量。缺 key 时 Kubernetes 阻止容器启动，空值/非法 endpoint 在 storage 初始化时失败。Compose 使用 `cumora-uploads` 持久卷。

OrbStack 模板提供免 R2 的单副本方案：`replicas: 1`、`Recreate` 更新策略、10Gi `ReadWriteOnce` uploads PVC 挂载到 `/app/server/uploads`，并显式设置 `CUMORA_REQUIRE_R2=false`。需要默认 StorageClass 与持久单节点存储；更新期间会短暂中断。**本地 uploads 卷不能扩到多副本/多节点，也不要配置 HPA。** 切换到 GKE 多副本前须把历史附件迁到 R2，验证上传下载；修改副本数不能替代迁移。已有 Pod 本地附件不会自动复制到新 PVC，应用配置前需在停写维护窗口备份并迁入，不能直接覆盖现有数据。

用 `CUMORA_NAMESPACE=<namespace> node scripts/render-k8s.mjs orbstack` 渲染，先创建 namespace/Secret 并单独完成迁移，再 apply。免 R2 时 Secret 不配置 R2 核心变量；完整 R2 配置仍优先选择 R2。运行 `storage-precheck.ts` 时使用与单副本 Pod 相同的环境并设置 `CUMORA_REQUIRE_R2=false`，缺省 R2 时输出 `storage preflight: local`。现有 GKE Deploy workflow 在迁移 Job 和候选 Pod 中强制 R2，继续只用于 GKE，多副本门禁不放宽；不要把它直接套用于本地 PVC 变体。preflight 只验证配置，不验证 PVC Bound、写权限、对象存储权限或历史附件迁移。

web 镜像的 HEALTHCHECK 校验 nginx 能返回实际 `index.html`。Compose 的 Node 探针仅发起一次 `/api/health` HTTP 请求（2 秒限时），不另建 PG/Redis 连接或重复请求 livez。应用 `/api/health` 使用共享连接执行 `SELECT 1` 和 `PING`，1 秒响应限时，合并未完成检查以避免连接池排队累积；不可用时返回脱敏的 503。K8s startup/liveness 仍只用 livez，不因数据库或 Redis 故障反复杀进程。

```sh
docker exec cumora-server node server/src/scripts/dependency-readiness.mjs
# 显式附加网关存活诊断；失败只输出警告，不改变 Cumora readiness 退出码：
docker exec cumora-server node server/src/scripts/dependency-readiness.mjs --gateway
```

sub2api 的 `/health` 仅代表其 HTTP 存活，不证明其数据库、Redis、账号授权、余额、模型、图片、SSE 或端到端业务可用。网关独立依赖与业务诊断应在其自身环境运行；不作为 Cumora 或 `.env` 兜底的硬就绪条件。

## 可执行备份与恢复演练

默认运维策略：每日 02:00 做完整备份，升级/迁移前额外做一次；保留最近 7 个日备份、4 个周备份、6 个按月备份，至少一份放在异机受访问控制的备份存储。建议备份位置为宿主专用目录 `/srv/backups/cumora/<UTC时间>/`（Windows 使用仓库外备份盘目录）；演练写到另一个空目录。每次备份包含 `database.dump`、`uploads/` 与 SHA-256/表行指纹 `manifest.json`。机密配置单独加密保管，不放进此备份包或日志。本仓库提供执行脚本，不会自动安装调度任务或执行保留清理；部署负责人需配置计划任务并告警备份失败。

**一致性前提**：在维护窗口暂停所有写入方（API 上传、后台任务、头像生成、GC，以及其他数据库客户端），保留 DB/Redis 运行，才复制 uploads 和数据库。脚本前后比对数据库表行指纹和源 uploads，发现变化即失败；这不能替代业务停写，也不能保证跨资源事务快照。`pg_dump` 自身提供数据库一致快照。目标目录必须不存在；失败包没有有效 manifest，不得用于恢复。禁止覆盖现有卷或向正式库执行 pg_restore。

```sh
# 先停写；BACKUP_ROOT/DRILL_ROOT 由运维设为仓库外目录。
mkdir -p "$BACKUP_ROOT/staging-uploads"
docker cp cumora-server:/app/server/uploads/. "$BACKUP_ROOT/staging-uploads"
node scripts/backup-restore-drill.mjs backup cumora-postgres "$BACKUP_ROOT/staging-uploads" "$BACKUP_ROOT/20260911T140000Z"
node scripts/backup-restore-drill.mjs restore "$BACKUP_ROOT/20260911T140000Z" "$DRILL_ROOT/20260911T140000Z"
# 不接触正式数据库/卷的端到端自测：
node scripts/backup-restore-drill.mjs self-test "$DRILL_ROOT/self-test-unique"
```

恢复脚本先校验 dump 和每个 uploads 文件的大小/SHA-256，再创建随机名称 `cumora-restore-*` 的 PostgreSQL 16 + pgvector 临时容器（无网络、无发布端口、PGDATA 为 tmpfs，不创建 Docker 卷），用 `pg_restore --exit-on-error` 恢复。随后逐表比对行数及排序行指纹（包括迁移账本），复制 uploads 到全新演练目录并再次逐文件校验。输出 `restore-result.json` 记录表数、行数、文件数、字节数和毫秒耗时；无论成功失败都移除本次临时容器，不删除任何卷。需预先具备 Docker、Node 及本地 `pgvector/pgvector:pg16` 镜像；不新增软件依赖。自测覆盖 vector、空表、二进制/中文文件名，并验证损坏的 dump/uploads 在恢复前被拒绝。

校验成功后，真实灾备仍需在隔离应用环境使用备份对应的镜像 digest 验证登录、历史附件、新上传及关键业务，再在人工维护窗口决定切换数据库/存储；脚本不会切换正式服务。保存部署文件、镜像 digest、备份时间与演练结果，以便复核。目标 RPO 为 24 小时（迁移前备份另计），初始目标 RTO 为 60 分钟；以实际完整数据演练修订，脚本耗时仅覆盖恢复和校验，不含下载备份、应用启动、流量切换。每月至少演练一次，升级 PG 大版本后重做。

适用范围为当前 Compose PostgreSQL 16 + 本地 uploads；脚本按 postgres socket 管理访问、数据库名 `cumora` 执行，不恢复角色/权限（由部署另行准备）。表数据会完整读入用于校验，单次子进程输出上限 256 MiB，大库应先评估内存与演练时间。GKE Cloud SQL 使用其原生备份/PITR 与隔离实例恢复，R2 使用独立备份桶/对象快照并保留相同 key，按对象清单导出到本地后复核文件 SHA-256；此脚本的本机自测不认证 Cloud SQL PITR、R2 灾备或正式数据 RPO/RTO。
