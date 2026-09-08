# Changelog

本 fork 基于 [yetone/cumora](https://github.com/yetone/cumora),track 本地自托管定制。上游变更见上游仓库。

## [Unreleased] — self-host customizations

### Added

- **ChatGPT Web 渠道经 sub2api 聚合**:本机 codex-chatgpt-web 桥接器(127.0.0.1:17841,驱动已登录的 ChatGPT 网页会话)作为 sub2api 的 OpenAI apikey 账号接入(base_url=http://host.docker.internal:17841,挂 max 组)。请求契约(经实测):模型用 `chatgpt-web/*` slug;body 需带 `client_metadata["x-codex-turn-metadata"]`(thread_id/turn_id/request_kind=turn/sandbox/workspaces)+ input 首条为 `<environment_context>`(cwd 须落在 metadata workspaces 内,sandbox_mode 与 metadata 一致)。端到端已验证:curl → sub2api 网关(用户 key 鉴权)→ 桥接器 → ChatGPT 网页真实回复。注意:账号 api_key 用的是 Codex access_token(会过期,过期只影响 native 直转与模型目录刷新,`chatgpt-web/*` 路径由桥接器本地浏览器会话驱动、不受影响;过期后从 ~/.codex/auth.json 重新读值更新账号 credentials)
- **sub2api 订阅聚合网关接入(多用户自动开通)**:compose 新增 `sub2api` 服务(从 fork [guanwenpeng2001-bot/sub2api](https://github.com/guanwenpeng2001-bot/sub2api) 构建,fork 补了 `POST /api/v1/admin/users/:id/api-keys` 管理端建 key 端点,开通流程不再依赖被 Turnstile 保护的 `/auth/*`);复用 cumora-postgres 里独立的 `sub2api` 库与 cumora-redis 逻辑库 1,宿主端口 8082。新注册/审批用户经 `server/src/sub2api.ts` `provisionUser` 四步(建用户→绑组→建 key→持久化)自动开通,tier→组映射由 `SUB2API_TIER_*_GROUP_ID` 配置;存量账号用 `server/src/scripts/provision-sub2api-user.ts` 手动开通(拒绝覆盖已有 key)。**注意:写入 key 前必须先在 sub2api 后台给组挂订阅账号,否则该用户 LLM 调用全断**(见 deploy/README.md)
- **全栈 Docker 化(一条命令起全部)**:仓库根新增 `docker-compose.yml`——db(pgvector/pgvector:pg16,复用外部卷 `cumora-pgdata`)、redis(复用 `cumora-redis-data`)、server(生产镜像,启动前串 `npm run migrate`;挂载容器可达的 kubeconfig 副本 `~/.kube/config-docker`,经 `host.docker.internal` + `tls-server-name: kubernetes` 保留完整 TLS 校验)、web(`deploy/web.Dockerfile` 多阶段构建 dist + nginx,发布 8080,反代 `/api`、`/ws` WebSocket、`/uploads` 到 server;DNS resolver 变量写法使 server 重建后无需 reload)。`deploy/README.md` 记录日常操作与已知限制
- **语音输入(语音转文字)**:聊天输入框新增麦克风按钮,MediaRecorder 录音后经服务端 `POST /api/audio/transcription` 转写,文字插入草稿(不自动发送)。ASR 走 DashScope 兼容模式(`input_audio` + chat/completions),主模型 + `OPENAI_AUDIO_FALLBACK_MODELS` 降级链。前端改动:`src/desktop/ChatPane.tsx`、`src/components/icons.tsx`、`src/api/client.ts`、双语 locale 文案。后端:`server/src/llm.ts`(`transcribeAudio`)、`server/src/api/router.ts`(新端点,鉴权 + 10MB 上限)
- **DashScope(阿里云百炼)图像通道**:`server/src/llm.ts` 新增 `getImageClient()` 与 `dashscopeImageClient`——双路由(qwen-image* 走同步 multimodal-generation,wan*/wanx* 走异步 text2image 任务轮询),支持 `OPENAI_IMAGE_FALLBACK_MODELS` 降级链,结果在 shim 内下载为 base64(绕开 fake-ip VPN DNS 导致的 SSRF 误伤)。`router.ts` 头像生成与 `cli.ts` `cumora image` 切换到该 client
- **可配置的 embedding 供应商**:`server/src/agents/embeddings.ts` 支持 `OPENAI_EMBED_BASE_URL` / `OPENAI_EMBED_API_KEY` / `OPENAI_EMBED_MODEL`,并显式传 `dimensions`(DashScope text-embedding-v4 可用)
- **orchestrator pod 环境注入**(`server/src/agents/runtime/orchestrator.ts`):pod 清单新增注入 `AGENT_RUNTIME_SECRET`、`REDIS_URL`、`DATABASE_URL`(localhost 改写为 host.docker.internal)、`NOVITA_API_KEY` / `NOVITA_BASE_URL`(per-agent `novita/<model>` 路由可用)、`OPENAI_MODEL`(此前缺失导致 pod 使用镜像默认模型名);`OPENAI_BASE_URL` 现在从环境变量读取而非仅 sub2api

### Fixed

- **语音输入竞态与健壮性**(ChatPane.tsx):getUserMedia 权限弹窗挂起期间切换房间 → 已卸载组件上 `rec.start()`(麦克风常亮)——await 后检查 unmount 标志,已卸载则停轨返回;快速连点麦克风 → 两个 recorder、第一个流泄漏——加同步门闩 `startingRef`;stop→onstop 极短窗口内再点 → `InvalidStateError`——stop 分支立即置 transcribing 并清空 recorderRef;录音加 120s 硬上限(到点自动停止并提示,已录片段照常转写,新增双语 locale key `chat.voiceMaxDuration`);转写失败 pill 统一显示本地化 `chat.voiceFailed`,原始英文报错只进 console;错误 pill 的 4.5s 自动清除改为可追踪 timer(新错误先 clear 旧定时器)
- **`resolveAssetUrl` 遗漏点补齐**(打包 Electron 下 404):NotificationWindow 通知头像、RichInput @提及 chip 头像、DocumentEditor 贴图(image 扩展 renderHTML 时解析,文档内容仍存相对路径,refresh-url 流程不受影响)、admin ObservabilityPage agent 头像;另修 `//cdn...` protocol-relative URL 被误判为相对路径的问题
- **打包桌面端(app:// 源)相对资源 URL 全部 404**:服务端返回的 `avatar_url` / 附件 `url` 是相对路径(`/uploads/...`),在 Electron 打包版里解析到 `app://cumora` 自身。新增 `resolveAssetUrl`(`src/api/client.ts`,以 `/` 开头时前缀 `getServerOrigin()`,浏览器同源部署返回 '' 时原样透传),接入所有消费者:`useCachedAvatarSrc`(头像统一入口,`fetchedFrom` 一律存解析后的绝对形式)、`AttachmentCard`(图片/下载/ImageViewer)、markdown 图片渲染器、邮件附件下载、AgentEditor 头像预览、WorkspaceSettingsModal 成员头像、admin UsersPage/WaitlistPage、桌面与移动 composer 附件预览
- Docker 镜像内 shell 脚本 CRLF 行尾导致 `exec /usr/local/bin/agent-entrypoint failed`(`server/docker/*.sh` 转 LF;Windows clone 的已知坑)
- inbox-triage `max_output_tokens` 500 → 2000:思维链模型(如 deepseek vision-exp)的 reasoning 会吃光 500 预算导致空 JSON、分拣失败

### Notes

- 本地部署模型矩阵:大脑 Kimi k3(OPENAI_BASE_URL 指向 Kimi coding 端点)、小脑/压缩 DeepSeek(经 `novita/` 前缀路由)、图像 DashScope、embedding DashScope text-embedding-v4
- K8s 使用 Docker Desktop 内置集群(context `docker-desktop`)+ squat/generic-device-plugin 提供 `/dev/fuse`
- 数据库容器使用 `pgvector/pgvector:pg16`(语义记忆);记账修复后 pod 可直连数据库(单租户本机环境接受的隔离让步)
