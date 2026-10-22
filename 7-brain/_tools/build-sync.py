"""Build what OpenReply's AI reads from this vault: 7-brain/03-output/openreply-sync.json.

Settings come from the 規則 pages, knowledge entries from every live, public page in
產品 and 常見問題 plus current.md, and the one link button from current.md.
Run: python3 7-brain/_tools/build-sync.py
"""
import json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WIKI = os.path.join(ROOT, "02-wiki")
LIMITS = {"role": 2000, "voice": 2000, "guardrails": 4000, "goals": 2000, "entry": 4000}
WAITLIST = "https://leo-waitlist.vercel.app/studio/"


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
    "guardrails": rule("AI 不能講的事") + "\n\n" + rule("特殊情況怎麼處理"),
    "goals": rule("粉絲回覆後怎麼接"),
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

links = [{
    "label": "加入早鳥名單",
    "url": WAITLIST,
    "description": "對方想加入、問怎麼報名、問價格或開賣時間，或對話最後要引導報名時。對方說已經報名就不要再送。",
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
