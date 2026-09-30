# 批量把「纯 Mock 声明」的大 alert 替换为轻量 MockTag 行
# 用法：python scripts/polish-mock-alerts.py（在 admin-web 目录下）
import io
import re

TARGETS = [
    "src/views/gateway/providers/index.vue",
    "src/views/gateway/models/index.vue",
    "src/views/gateway/keys/index.vue",
    "src/views/gateway/router/index.vue",
    "src/views/gateway/pipelines/index.vue",
    "src/views/gateway/usage/index.vue",
    "src/views/extensions/list/index.vue",
    "src/views/extensions/rules/index.vue",
    "src/views/extensions/commands/index.vue",
    "src/views/memory/stores/index.vue",
    "src/views/memory/records/index.vue",
    "src/views/memory/retrieval/index.vue",
    "src/views/memory/embedding/index.vue",
    "src/views/observability/logs/index.vue",
    "src/views/observability/events/index.vue",
    "src/views/observability/ai-calls/index.vue",
    "src/views/observability/errors/index.vue",
    "src/views/system/users/index.vue",
    "src/views/system/settings/index.vue",
    "src/views/system/permissions/index.vue",
]

# 自闭合：<el-alert ... title="..."/>（属性跨行，DOTALL）
SELF_CLOSED = re.compile(
    r'[ \t]*<el-alert\b[^>]*type="info"[^>]*title="([^"]*)"[^>]*/>\r?\n',
    re.S,
)
# 双标签：<el-alert ...>...#title...</el-alert>（含 Mock 字样才替换）
PAIRED = re.compile(
    r'[ \t]*<el-alert\b[^>]*type="info"[^>]*>\s*(?:<template #title>)?(.*?)</template>\s*</el-alert>\r?\n',
    re.S,
)

for path in TARGETS:
    s = io.open(path, encoding="utf-8").read()
    replaced = False

    def sub_self(m):
        global replaced
        title = m.group(1).strip()
        if "Mock" not in title and "mock" not in title:
            return m.group(0)
        replaced = True
        d = title.replace('"', "&quot;")
        return (
            f'      <div class="flex justify-end mb-1">\n'
            f'        <MockTag detail="{d}" />\n'
            f"      </div>\n"
        )

    s2 = SELF_CLOSED.sub(sub_self, s)
    if not replaced:
        # 双标签变体：整块换成一个 MockTag 行，详情文案以注释保留
        def sub_paired(m):
            global replaced
            inner = re.sub(r"<[^>]+>", "", m.group(1))
            inner = re.sub(r"\s+", " ", inner).strip()
            if "Mock" not in inner and "mock" not in inner:
                return m.group(0)
            replaced = True
            d = inner.replace('"', "&quot;")
            return (
                f'      <div class="flex justify-end mb-1">\n'
                f'        <MockTag detail="{d}" />\n'
                f"      </div>\n"
            )

        s2 = PAIRED.sub(sub_paired, s)

    if replaced:
        io.open(path, "w", encoding="utf-8", newline="\n").write(s2)
        print(f"OK  {path}")
    else:
        print(f"SKIP {path}（未找到可替换的 Mock alert）")
