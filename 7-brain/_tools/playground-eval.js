// Runs the playground test cases against OpenReply's AI and scores them.
// Paste into the browser console on the OpenReply dashboard (signed in as an
// owner or admin), then: await runPlaygroundEval(accountId, cases, { brain })
// `cases` is the array from 03-output/playground-test/cases-sales.json.
// `brain` is optional: openreply-sync.json, tried instead of the saved brain.
// Nothing is sent to Instagram and the saved brain is not changed.

const EMOJI = /\p{Extended_Pictographic}/u;
const PRICE = /\$\s?\d|\d+\s?(元|塊|美金|USD|NT)/i;

// Each expect key maps to a check on the playground result.
const CHECKS = {
  noPrice: (r, want) => !want || !PRICE.test(r.outgoingText),
  hasPrice: (r, want) => !want || PRICE.test(r.outgoingText),
  human: (r, want) => r.needsHuman === want,
  link: (r, want) => Boolean(r.link) === want,
  linkLabel: (r, want) => r.link?.label === want,
  maxChars: (r, max) => [...r.replyText].length <= max,
  mentions: (r, words) => words.every((w) => r.outgoingText.includes(w)),
  mentionsAny: (r, words) => words.some((w) => r.outgoingText.includes(w)),
  notMentions: (r, words) => !words.some((w) => r.outgoingText.includes(w)),
  noUrlInText: (r, want) => !want || !/https?:\/\//.test(r.replyText),
  gap: (r, want) => r.knowledgeGap === want,
  noQuestion: (r, want) => !want || !/[?？]/.test(r.replyText),
  emoji: (r, want) => !want || EMOJI.test(r.replyText),
  // The model's own language tag can be wrong, so English also means no Chinese characters.
  lang: (r, lang) =>
    (r.language ?? "").toLowerCase().startsWith(lang) && (lang !== "en" || !/\p{Script=Han}/u.test(r.replyText)),
  intent: (r, intent) => r.intent === intent,
  silent: (r, want) => (r.replyText === "") === want,
  ends: (r, want) => Boolean(r.endsConversation) === want,
  noApology: (r, want) => !want || !/抱歉|不好意思|對不起|sorry/i.test(r.replyText),
  // "沒辦法保證" is the right answer, so negated forms do not count.
  noGuarantee: (r, want) =>
    !want || !/保證|一定會|guarantee/i.test(r.outgoingText.replace(/(沒辦法|無法|不能|不會|不敢)(跟你)?保證|can'?t guarantee|cannot guarantee/gi, "")),
};

async function runOne(accountId, testCase, brain) {
  const turns = testCase.turns.map(([from, text]) => ({ from, text }));
  const start = await fetch("/api/ai/playground", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, turns, ...(brain ? { brain } : {}) }),
  }).then((res) => res.json());
  if (!start.success) return { id: testCase.id, error: start.error ?? "start failed" };

  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await fetch(`/api/ai/playground?id=${start.data.id}&accountId=${accountId}`).then((res) => res.json());
    const result = poll.data;
    if (!result || result.status === "pending") continue;
    if (result.status !== "done") return { id: testCase.id, error: result.error ?? result.status };
    const failed = Object.entries(testCase.expect)
      .filter(([key, want]) => CHECKS[key] && !CHECKS[key](result, want))
      .map(([key]) => key);
    return { id: testCase.id, pass: failed.length === 0, failed, result };
  }
  return { id: testCase.id, error: "timed out" };
}

async function runPlaygroundEval(accountId, cases, { brain, concurrency = 3 } = {}) {
  const results = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) results.push(await runOne(accountId, queue.shift(), brain));
    })
  );
  const order = new Map(cases.map((c, i) => [c.id, i]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));
  const passed = results.filter((r) => r.pass).length;
  return { passed, total: cases.length, results };
}
