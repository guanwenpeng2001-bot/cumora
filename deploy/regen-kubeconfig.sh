#!/usr/bin/env bash
# 重新生成供容器使用的 kubeconfig(config-docker)。
# 何时需要:Docker Desktop 重启后 K8s apiserver 的转发端口可能变化,
# 表现为 server 容器日志里 kubectl 报错 / agent pod 拉不起来。跑一次本脚本即可。
set -euo pipefail

SRC="$HOME/.kube/config"
DST="$HOME/.kube/config-docker"

if [ ! -f "$SRC" ]; then
  echo "找不到 $SRC —— Docker Desktop 的 Kubernetes 没开过?"
  exit 1
fi

# 从当前 kubeconfig 里取 docker-desktop 集群的实际转发端口
PORT=$(grep -oE 'server: https://127\.0\.0\.1:[0-9]+' "$SRC" | head -1 | grep -oE '[0-9]+$')
if [ -z "$PORT" ]; then
  echo "在 $SRC 里没找到 127.0.0.1 的 server 地址,格式可能变了,把 $SRC 发给维护者看"
  exit 1
fi

cp "$SRC" "$DST"
# 容器内经 host.docker.internal 访问宿主机转发端口;
# apiserver 证书 SAN 不含 host.docker.internal,用 tls-server-name 保留完整 CA 校验
sed -i "s|server: https://127.0.0.1:$PORT|server: https://host.docker.internal:$PORT|" "$DST"

# 注入 tls-server-name(若已存在则先删再加,保持幂等)
grep -v 'tls-server-name' "$DST" > "$DST.tmp" || true
sed -i "s|server: https://host.docker.internal:$PORT|server: https://host.docker.internal:$PORT\n    tls-server-name: kubernetes|" "$DST.tmp"
mv "$DST.tmp" "$DST"

echo "已生成 $DST (端口 $PORT)"
# 用正在运行的 server 容器实测(它已挂载这份 kubeconfig)
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
cd "$(dirname "$0")/.."
MSYS_NO_PATHCONV=1 docker compose exec -T server kubectl get ns >/dev/null 2>&1 \
  && echo "连通性 OK(server 容器内 kubectl 可用)" \
  || echo "注意:server 容器未运行或连通失败——若刚重启 Docker Desktop,先 docker compose up -d 再重跑本脚本"
