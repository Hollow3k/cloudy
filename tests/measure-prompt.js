// Measures the size of the request "Suggest next action" would send for one
// fixture + goal: characters of the TARGETS block and the real prompt token count
// reported by the local Ollama (prompt_eval_count, generating 1 token only).
// A random 8-digit nonce is put in front of the system prompt so Ollama's prompt
// cache cannot hide part of the prompt; the nonce is the same length every run.
//   node tests/measure-prompt.js <fixture> "<goal>" [runs]
const realFetch = global.fetch; // fake-panel.js replaces global.fetch; keep the real one for Ollama
const { load } = require("./fake-panel.js");
const fixture = process.argv[2];
const goal = process.argv[3];
const runs = Number(process.argv[4] || 3);

(async () => {
  const p = load();
  p.useAction(fixture);
  p.reply({ rationale: "x", action: "cannot", target_id: "", text: "", direction: "", question: "", reason: "x" });
  await p.suggest(goal);
  const body = p.state.fetchCalls[0].body;
  const targetsText = body.prompt.slice(body.prompt.indexOf("TARGETS ("), body.prompt.indexOf("<<<PAGE_END>>>"));
  const result = { fixture, goal, model: body.model, promptChars: body.prompt.length, systemChars: body.system.length, targetsChars: targetsText.length, tokens: [] };
  try {
    for (let i = 0; i < runs; i++) {
      const nonce = String(Math.floor(10000000 + Math.random() * 89999999));
      const res = await realFetch("http://localhost:11434/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, system: nonce + "\n" + body.system, stream: false, options: { num_predict: 1, temperature: 0 } }),
        signal: AbortSignal.timeout(170000),
      });
      const data = await res.json();
      result.tokens.push(data.prompt_eval_count);
    }
  } catch (e) { result.error = String(e.message || e); }
  console.log(JSON.stringify(result));
  console.log("--- TARGETS block as sent ---\n" + targetsText);
  process.exit(0);
})();
