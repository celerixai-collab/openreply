"""Build what OpenReply's AI reads from this vault: 7-brain/03-output/openreply-sync.json.

Settings come from the 規則 pages, knowledge entries from every live, public page in
產品 and 常見問題 plus current.md, the objection library (異議) and the example
conversations (對話範例), and the one link button from current.md. Objections and
examples are synced while still drafts so they can be tried in the playground;
the AI stays off until Leo confirms them.
Run: python3 7-brain/_tools/build-sync.py
"""
import json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WIKI = os.path.join(ROOT, "02-wiki")
LIMITS = {"role": 2000, "voice": 2000, "guardrails": 4000, "goals": 2000, "entry": 4000}
BUY_URL = "https://openreply-coral-three.vercel.app/r/xnJVq5OSJw"


def read(path):
    text = open(path, encoding="utf-8").read()
    meta, body = {}, text
    if text.startswith("---\n"):
        head, body = text[4:].split("\n---\n", 1)
        for line in head.splitlines():
            if ": " in line:
                key, value = line.split(": ", 1)
                meta[key.strip()] = value.strip()
    return meta, plain(body)


def plain(text):
    text = re.sub(r"\[\[([^\]|]+)(\|[^\]]+)?\]\]", r"\1", text)  # [[link]] -> link
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    return text.strip()


def rule(name):
    return read(os.path.join(WIKI, "規則", name + ".md"))[1]


def split_voice(text):
    role, _, rest = text.partition("語氣：")
    return role.replace("角色：", "").strip(), "語氣：" + rest.strip()


role, voice = split_voice(rule("AI 的角色與語氣"))
voice, _, disclosure = voice.partition("AI 揭露文字：")
settings = {
    "role": role,
    "voice": voice.strip(),
    "guardrails": "\n\n".join(rule(name) for name in ("AI 不能講的事", "特殊情況怎麼處理", "學到的規則")),
    "goals": rule("對話階段"),
    "humanPauseHours": 1,
    "knowledge": "",
}

entries = []
current = read(os.path.join(ROOT, "current.md"))[1]
entries.append({"title": "目前事實（以這裡為準）", "content": current})
for folder in ["產品", "常見問題"]:
    for name in sorted(os.listdir(os.path.join(WIKI, folder))):
        meta, body = read(os.path.join(WIKI, folder, name))
        if meta.get("status") != "live" or meta.get("public") != "true":
            continue
        content = f"粉絲可能這樣問：{meta.get('questions', '').strip('[]')}\n可以直接回：{meta.get('answer_short', '')}\n\n{body}"
        entries.append({"title": meta["title"], "content": content})
for folder, label in [("異議", "異議"), ("對話範例", "對話範例")]:
    for name in sorted(os.listdir(os.path.join(WIKI, folder))):
        meta, body = read(os.path.join(WIKI, folder, name))
        if meta.get("status") == "outdated":
            continue
        entries.append({"title": f"{label}：{meta['title']}", "content": body})

links = [{
    "label": "購買教學",
    "url": BUY_URL,
    "description": "看時機送：他問價格、怎麼買、要連結、付款問題，說出痛點，或回答完疑慮、處理完猶豫、第一次拒絕再推時。剛打招呼、純聊天、上一則剛送過、說已經買了、罵人、用 Windows、第二次拒絕時不送。",
}]

problems = [f"{k} is {len(settings[k])} chars (max {LIMITS[k]})" for k in ("role", "voice", "guardrails", "goals") if len(settings[k]) > LIMITS[k]]
problems += [f"entry {e['title']} is {len(e['content'])} chars" for e in entries if len(e["content"]) > LIMITS["entry"]]
if problems:
    sys.exit("Too long:\n" + "\n".join(problems))

out = os.path.join(ROOT, "03-output", "openreply-sync.json")
json.dump({"settings": settings, "entries": entries, "links": links}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"{len(entries)} entries, 1 link -> {os.path.relpath(out, ROOT)}")
for k in ("role", "voice", "guardrails", "goals"):
    print(f"  {k}: {len(settings[k])} chars")
