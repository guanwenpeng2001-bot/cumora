# Docker 自托管部署

基础层 `docker-compose.yml` 独立运行 Cumora。只有显式叠加 `docker-compose.gateway.yml` 才创建 sub2api 服务并要求网关引导凭据。以下命令中的 `config` 仅解析配置,不连接数据库、不运行迁移、不启动或重建容器。

## 服务与持久化身份

| 层 | 服务 | 容器名 | 端口 | 说明 |
|---|---|---|---|---|
| 基础 | db | cumora-postgres | 5432 | pgvector/pgvector:pg16;外部卷 `cumora-pgdata` |
| 基础 | redis | cumora-redis | 6379 | redis:7;外部卷 `cumora-redis-data` |
| 基础 | migrate | cumora-migrate | — | server 镜像;一次性执行 `npm run migrate` |
| 基础 | server | cumora-server | 5181 | API、调度器、orchestrator;等待 migrate 成功退出 |
| 基础 | web | cumora-web | 8080 | nginx SPA;反代 `/api`、`/ws`、`/uploads` |
| 可选网关 | sub2api | cumora-sub2api | 8082 | 本地 fork `../sub2api` 构建;保留原镜像标签与数据卷 |

基础层为五个服务定义(含一次性 migrate),叠加后为六个;正常长期运行的原五容器身份不变。项目名仍为 `cumora`,默认网络仍为 `cumora_default`,网关命名卷仍为 `cumora_sub2api-data`。如果既有部署通过 `-p` 或 `COMPOSE_PROJECT_NAME` 指定过项目名,所有后续命令必须继续使用同一值,以保留原网络及网关卷前缀。不要添加新的网络/卷名称或更换项目名。

sub2api 继续复用 db 内独立的 `sub2api` 数据库及 Redis 逻辑库 1。基础 Compose 不负责创建该数据库;新环境需在另行授权的初始化步骤中准备,现有环境不重建、不修改数据。`server → migrate(service_completed_successfully) → db(service_healthy)` 的迁移门槛保持不变;server 还等待 Redis 健康。网关仅依赖 db/redis 健康,server/web 不依赖网关健康或启动成功。

## 前提和地址语义

1. 仓库根 `.env` 为本地私密配置,可参考 `.env.example`,绝不提交。Compose 从它读取插值,server/migrate 继续通过 `env_file` 接收运行配置;容器内 `DATABASE_URL` / `REDIS_URL` 仍由 Compose 覆盖为 db/redis 服务名。`--env-file` 只改变插值来源,不会替换服务的 `env_file: .env`。
2. 沿用外部卷和可用的 K8s 集群。`${KUBECONFIG_DOCKER:-${USERPROFILE:-${HOME}}/.kube/config-docker}` 挂到 server 的 `/root/.kube/config`,副本中的 API endpoint 必须从 server 容器可达。保留 CA 校验,需要时设置与证书 SAN 匹配的 `tls-server-name`;实际 endpoint/端口由部署填写。非 Windows 主机用 `KUBECONFIG_DOCKER` 显式指定该副本路径。
3. 浏览器入口、server 内部地址和 Pod 地址分别验证。`SUB2API_INTERNAL_URL` 是 server 的网关根 URL(不附 `/v1`),本 Compose 网络内可使用 `http://sub2api:8080`。实际值由 `.env` 提供,可选层不硬编码运行地址。
4. 当前 Pod URL 转换会把上述内部前缀替换为 `SUB2API_PUBLIC_URL`,因此该变量虽然名为 PUBLIC,也必须是 **Pod 可达的集群/内部根 URL**。Compose 服务 DNS 不自动跨入 K8s;不要给 Pod 仅在 Compose 内可解析的地址。优先使用 Pod 可达的内部服务或内部入口,避免带短请求超时的公网 Ingress。浏览器管理入口若另有地址,单独记录,不能拿它替代 Pod 可达性验证。
5. T36 启动快照及后续刷新沿用映射后的 gateway 地址与租户凭据;管理 key 不应传入 Pod。纯 env 的各 direct endpoint 同样必须从 server/Pod 可达。Pod 访问 Cumora server 的地址也需按实际集群网络核验。

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
- `SUB2API_TIER_<FREE|PRO|MAX>_GROUP_<OPENAI|KIMI|DEEPSEEK|GROK>`:已配置平台分组。兼容变量见 `.env.example`,实际组类型和额度沿用已授权配置。
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

反之不带 `-f` 直接 `docker compose up` 时,override 会被自动叠加,但它不应声明基础层没有的服务名。

## 形态三:网关 + env 后备

使用与纯网关相同的两个 Compose 文件、网关身份和服务拓扑,再为允许后备的角色配置独立 direct key、endpoint、模型和协议。凭据填写本身不会开启后备。

完整策略依赖 T52 的 `env_after_chain` 落地:在该策略提供的设置入口显式启用后,只有网关候选耗尽且符合降级分类时才走 direct;关闭策略或缺少有效 direct 凭据时应明确失败。Cumora 自身认证/授权失败不能触发外呼,embedding 不使用自动模型或出口降级。direct 请求应记录在 Cumora 用量台账,不计入 sub2api 扣费。

当前 T46 只交付部署组合与凭据准备说明;当前源码尚未提供 `env_after_chain`,没有可在本文件中承诺有效的同名环境变量。T52 完成后再按其设置契约启用,并在隔离环境验证网关不可达、后备成功、关闭后备、缺凭据和错误归因,才能将混合形态的自动后备标为可用。

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

本次部署定义将 server 容器探针指向 `/api/livez`,其处理器只检查进程响应、不查网关或数据库。`/api/health` 继续作为数据库 readiness 检查使用。配置验收可确认探针与依赖不绑定网关,真实网关故障与 Pod 连通性仍须另行在隔离环境实测。

后续发布先完成源码/制品和 schema 兼容核验,再按获准窗口应用目标服务。server 启动必须继续等待一次性 migrate 成功,失败时先查迁移日志,不能绕过门槛。回退恢复原文件组合、固定镜像及运行值;保留原卷、账号、session 和数据库,数据库回退遵循 schema gate,不删历史迁移或改 checksum。本次配置实施不启动、停止或重建任何容器。

## 浏览器与 OAuth

Web 发布端口为 8080,API 为 5181;外部实际域名由部署填写。若通过容器 Web 登录,把浏览器入口加入 `CUMORA_AUTH_RETURN_ALLOWLIST`,并将认证完成地址指向该 Web 入口。独立前端需要相应 CORS 配置;Pod 内部地址和浏览器 OAuth 地址不能混用。宿主机已有进程占用端口时先安排独立运维窗口,不要在配置解析任务中停止它们。
