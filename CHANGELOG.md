# Changelog

本 fork 基于 [yetone/cumora](https://github.com/yetone/cumora),track 本地自托管定制。上游变更见上游仓库。

## [Unreleased] — self-host customizations

### Added

- **语音输入(语音转文字)**:聊天输入框新增麦克风按钮,MediaRecorder 录音后经服务端 `POST /api/audio/transcription` 转写,文字插入草稿(不自动发送)。ASR 走 DashScope 兼容模式(`input_audio` + chat/completions),主模型 + `OPENAI_AUDIO_FALLBACK_MODELS` 降级链。前端改动:`src/desktop/ChatPane.tsx`、`src/components/icons.tsx`、`src/api/client.ts`、双语 locale 文案。后端:`server/src/llm.ts`(`transcribeAudio`)、`server/src/api/router.ts`(新端点,鉴权 + 10MB 上限)
- **DashScope(阿里云百炼)图像通道**:`server/src/llm.ts` 新增 `getImageClient()` 与 `dashscopeImageClient`——双路由(qwen-image* 走同步 multimodal-generation,wan*/wanx* 走异步 text2image 任务轮询),支持 `OPENAI_IMAGE_FALLBACK_MODELS` 降级链,结果在 shim 内下载为 base64(绕开 fake-ip VPN DNS 导致的 SSRF 误伤)。`router.ts` 头像生成与 `cli.ts` `cumora image` 切换到该 client
- **可配置的 embedding 供应商**:`server/src/agents/embeddings.ts` 支持 `OPENAI_EMBED_BASE_URL` / `OPENAI_EMBED_API_KEY` / `OPENAI_EMBED_MODEL`,并显式传 `dimensions`(DashScope text-embedding-v4 可用)
- **orchestrator pod 环境注入**(`server/src/agents/runtime/orchestrator.ts`):pod 清单新增注入 `AGENT_RUNTIME_SECRET`、`REDIS_URL`、`DATABASE_URL`(localhost 改写为 host.docker.internal)、`NOVITA_API_KEY` / `NOVITA_BASE_URL`(per-agent `novita/<model>` 路由可用)、`OPENAI_MODEL`(此前缺失导致 pod 使用镜像默认模型名);`OPENAI_BASE_URL` 现在从环境变量读取而非仅 sub2api

### Fixed

- Docker 镜像内 shell 脚本 CRLF 行尾导致 `exec /usr/local/bin/agent-entrypoint failed`(`server/docker/*.sh` 转 LF;Windows clone 的已知坑)
- inbox-triage `max_output_tokens` 500 → 2000:思维链模型(如 deepseek vision-exp)的 reasoning 会吃光 500 预算导致空 JSON、分拣失败

### Notes

- 本地部署模型矩阵:大脑 Kimi k3(OPENAI_BASE_URL 指向 Kimi coding 端点)、小脑/压缩 DeepSeek(经 `novita/` 前缀路由)、图像 DashScope、embedding DashScope text-embedding-v4
- K8s 使用 Docker Desktop 内置集群(context `docker-desktop`)+ squat/generic-device-plugin 提供 `/dev/fuse`
- 数据库容器使用 `pgvector/pgvector:pg16`(语义记忆);记账修复后 pod 可直连数据库(单租户本机环境接受的隔离让步)
