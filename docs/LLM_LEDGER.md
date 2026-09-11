# 统一台账 v2 与用量汇总 v3（Wave B / P2）

本波只接管调用事实、参考计价、可靠遥测和统计；不修改 free/pro/max 权益、额度准入、排队、sub2api 平台组或现有模型选择规则。部署仍需现有主服务、PostgreSQL、Redis 和受管运行时/K8s 前提；不支持只安装 BYOA 而省略 K8s 的部署模式。

## 迁移与兼容

先运行迁移，再发布支持 schema 23 的主服务。20 扩展事实表并增加版本价格、结算 journal、实例心跳、v3 桶状态；21 在事务外并发创建新事件和 attempt 的部分唯一索引，并处理失败后残留的无效索引；22 增加受信任网关回执幂等键、身份约束、历史兼容价格归档和价格生效区间关闭规则。23 为 v3 补充实际/请求模型和报告状态，标脏旧桶后重建，避免同名却不同证据的分组混合。历史迁移 1–19 不变。

历史数据只用明确的 routeKind/source 恢复三类来源。没有证据时 source_kind/provider_id 留空，quality 标记为 legacy_unknown；它不是第四种来源。不删除已有重复调用。旧 /runtime/llm-calls payload 可继续使用一个发布周期，标记 schema_version=1、usage_provenance=legacy_unknown。旧金额字段为兼容投影，新读者使用可空的 NUMERIC 金额。

`requested_model` 是用户/角色选择，`request_model` 是实际发送名称，`actual_model` 只接受上游/daemon 的报告，缺失为 NULL。daemon 报告不构成可信上游账单；BYOA upstream_cost_usd 保持 NULL，quota_debit=0 仅表示不占 cumora 套餐额度。

## 持久目录与恢复

主服务的 `CUMORA_SETTLEMENT_OUTBOX_DIR` 默认是工作目录下 `server/uploads/.llm-settlement`，对应当前 Compose 已有的 cumora-uploads 持久卷。独立部署和多副本部署必须为每个写入实例配置持久卷，并在替换实例后重新挂载其目录。启用对象存储不能替代这个文件 journal；不要将它放在 Pod 临时文件系统，也不要删除未 ACK 的文件。目录不包含提示词；事件保留计量、路由身份和最终状态。应把整个持久目录纳入备份与磁盘容量监控。

顺序：短事务持久化 started → 结束事务 → HTTP 请求/消费流 → fsync 最终事件 → 数据库 journal → 同 attempt_id 幂等写终态 → 删除数据库 journal 和本地文件。数据库暂时不可用时，后台每 10 秒重放；返回路径已持久化事件但数据库尚未结算时，started/pending 仍可在用量页识别。持久目录写入失败会向调用者报错，不能宣称已可靠完成结算。默认文件 journal 上限 128 MiB，不丢弃旧事件腾空间。

实例心跳超过两分钟未更新，其 started 转为 indeterminate，金额和用量保持未知；不会按超时推定零消费。恢复后同 attempt 的最终事件仍可补齐。短事务不会跨 HTTP 持有连接。SDK 隐式重试关闭；应用级下一次 HTTP 发送创建另一 attempt。

BYOA 在 `~/.cumora/.usage-outbox/<server-hash>/<agent-id>/` 先持久化稳定事件，重启后重新读取；仅收到包含 producerEventId 的明确 ACK 才删除。目录位于模型工作目录之外。磁盘满会报告 telemetry incomplete，不能丢弃旧事件或伪造零用量。此行为不改变急停、预算暂停期间消息保留排队的规则。

## API 和计数口径

- `POST /runtime/llm-calls` v2：`{schemaVersion:2, producerEventId, engineSessionId, engine, profileRef, occurredAt, daemonVersion, attempts:[oneObservation]}`。每个事件封装一个观测；daemon 连续上报多个事件。返回 `{ok:true,schemaVersion:2,acknowledgedEventIds:[id]}`。身份由运行时授权绑定推导，不接受 payload 的 source/computer/provider/金额归属。事件中的 engine/profileRef 只与授权绑定作匹配；重绑后不能把旧事件改记为新引擎或 profile，拒绝时不 ACK。
- 一次 cumora→网关 HTTP 请求是一条主 attempt。`traceparent` 和 `X-Cumora-Attempt-Id` 随 SDK 请求发送。网关账号内部重试作为同一 attempt 的子证据，不增加消费条数；当前子 span 覆盖仍为 partial。
- `applyGatewayReceipt` 是仅供受信任服务端 adapter 调用的 P4 接口，按 gateway_request_id+event_version 幂等补证；不向 BYOA 或普通用户开放。P4 负责认证、拉取游标和真实回执传输。本波不会主动访问或修改 sub2api 的账本。
- BYOA 有逐请求证据时用 provider_request；只有 turn 总量时用 engine_turn。同一会话/run/purpose 不允许两种粒度混算。现有引擎转增量行为保留。
- `/api/usage/summary,trend,by-agent,by-model,by-provider,by-source,logs` 共用 source/platform/provider/capability/role/purpose/agentId/runId 过滤；source 只接受 sub2api/env/byoa。旧 source=cloud/byoa-engine 参数继续兼容。日志按 logicalCall 分页，再返回完整 attempts；页大小限制针对逻辑调用。

## 价格与金额

管理员可 `PUT /api/admin/models/:offeringId/prices` 发布 `{effectiveFrom,effectiveTo?,unitSchema,rates,note?}`。rates 必须是非负十进制字符串；token 默认按百万，支持 input/cache_read/cache_write/output 与上下文档位，媒体/请求单位使用 unit 费率。新版本可关闭前一版本开放的生效区间，但不能修改费率或已有调用快照。

旧价格只在单一 offering 的精确请求名称下归档为 historical compatibility，生效截止迁移时点，不自动授权未来价格，也不重算历史消费。同名多出口要分别审核发布价格。未知/未配置使用 no_price、usage_unavailable、unit_quantity_unavailable、unsupported_billing_unit、unknown_alias、price_version_missing、external_subscription、invalid_usage，金额为 NULL。价格匹配不跨 provider 或用展示名称猜测。参考成本、上游确认成本、套餐扣额是独立金额；P3 发布正式 tariff/额度扣减后才能写入云调用的 quota_debit，当前为 NULL。

## 汇总、保留与回滚

v3 按 UTC 小时分桶，保存 source/provider/offering/capability/role 和 logical_call_id。一次刷新至多处理 48 个已闭合脏桶：先锁桶、删除该桶全部旧分组，再从 occurred_at 范围整体重建，最后认证 ready。并发迟到事件在事务提交后重新标脏。不同模型的 distinct logicalCall 不相加，查询跨分组重新 distinct。

每桶只允许 raw、v3、v2 或 v1 中一个拥有统计权。半小时边界、未闭合和脏桶读 raw；未覆盖的历史按旧水位选择 v2/v1，并保留质量未知及覆盖范围提示。不因为汇总失败或切换而叠加两个版本。

原 90 天 llm_calls 删除目标已移除，账务事实暂时保守保留；不重建或删除其他数据库/卷。P3 确定账务保留期后再实现最小事实的归档/过期策略。embedding 空间与维度检查保持原样，不触发全库重建。

回滚时保留新表、字段、journal 和恢复消费者；停止 v3 读取/回填可以恢复兼容报表，但不能恢复只在内存投递结算。旧二进制会被 schema guard 拒绝，应发布理解新增迁移的兼容回滚版本。不要删除 started/pending/indeterminate 或仍待回放的事件。
