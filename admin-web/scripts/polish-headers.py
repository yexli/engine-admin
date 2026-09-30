# 把 el-table-column 的内联双语 label（“中文 English”）转换为 #header + BiText
# 用法：python scripts/polish-headers.py（在 admin-web 目录下）
import io
import re
import glob

# 列开标签，label 值形如 “中文 English”（含至少一个 ASCII 词）
COL = re.compile(r'(<el-table-column\b[^>]*?)\slabel="([^"]+)"([^>]*?)(/?)>')

def split_label(label):
    """“定价 Pricing（输入/输出）” → (定价, Pricing（输入/输出）)；纯中文或无英文 → None"""
    m = re.match(r"^(\S[^']*?)\s+([A-Za-z][A-Za-z0-9 /.&()·+-]*)$", label)
    if not m:
        return None
    zh, en = m.group(1).strip(), m.group(2).strip()
    # 英文部分必须真有 ASCII 字母
    if not re.search(r"[A-Za-z]", en):
        return None
    return zh, en

def conv(m):
    head, label, tail, selfclose = m.group(1), m.group(2), m.group(3), m.group(4)
    parts = split_label(label)
    if not parts:
        return m.group(0)
    zh, en = parts
    zh = zh.replace('"', "&quot;")
    en = en.replace('"', "&quot;")
    header = f'<template #header><BiText zh="{zh}" en="{en}" /></template>'
    if selfclose:
        return f"{head}{tail}>{header}</el-table-column>"
    return f"{head}{tail}>{header}"

total = 0
for path in glob.glob("src/views/**/index.vue", recursive=True) + glob.glob(
    "src/views/runtime/components/*.vue"
):
    s = io.open(path, encoding="utf-8").read()
    if "label=\"" not in s:
        continue
    s2, n = COL.subn(conv, s)
    if n:
        io.open(path, "w", encoding="utf-8", newline="\n").write(s2)
        total += n
        print(f"OK {path}  ({n} 列)")
print(f"=== 共转换 {total} 列 ===")
