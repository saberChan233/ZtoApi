// Offline replay/diagnostic for the Z.ai tool-call bridge.
//
// Feeds raw upstream model output captured by ZAI_BRIDGE_DEBUG_DUMP back through
// the bridge's tool-call extractor, WITHOUT touching z.ai. This is how we debug
// "the model answered but the client saw no tool call" without guessing: it
// shows exactly what the model emitted and whether the bridge recognized a call.
//
// Usage:
//   deno run --allow-read scripts/replay_bridge.ts /path/to/zto_dump.jsonl
//
// The dump file is JSONL; each line is one bridge turn with fields:
//   { ts, model, stream, tool_choice, client_tools[], recognized_tool_calls[],
//     content, reasoning_content }

import { extractZaiBridgeToolCalls, type Tool } from "../main.ts";

interface DumpRecord {
  ts?: string;
  model?: string;
  stream?: boolean;
  client_tools?: string[];
  recognized_tool_calls?: string[];
  content?: string;
  reasoning_content?: string;
}

function toolsFromNames(names: string[]): Tool[] {
  return names.map((name) => ({
    type: "function",
    function: { name, description: "", parameters: {} },
  }));
}

function preview(text: string, max = 4000): string {
  const t = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max) + " …[+" + (t.length - max) + "]" : t;
}

function main() {
  const path = Deno.args[0];
  if (!path) {
    console.error(
      "usage: deno run --allow-read scripts/replay_bridge.ts <dump.jsonl>",
    );
    Deno.exit(2);
  }
  const raw = Deno.readTextFileSync(path);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`# replay_bridge: ${lines.length} record(s) from ${path}\n`);

  let idx = 0;
  for (const line of lines) {
    idx++;
    let rec: DumpRecord;
    try {
      rec = JSON.parse(line) as DumpRecord;
    } catch (e) {
      console.log(`--- record ${idx}: UNPARSEABLE (${String(e)})`);
      continue;
    }
    const tools = toolsFromNames(rec.client_tools || []);
    const content = rec.content || "";
    const reasoning = rec.reasoning_content || "";
    const recognized = extractZaiBridgeToolCalls(content, tools);

    console.log(`--- record ${idx} (${rec.ts || "?"}) model=${rec.model}`);
    console.log(`  client_tools: [${(rec.client_tools || []).join(", ")}]`);
    console.log(
      `  content_len=${content.length} reasoning_len=${reasoning.length}`,
    );
    console.log(
      `  recognized_now=${recognized.length}` +
        (recognized.length
          ? ` -> [${recognized.map((c) => c.function.name).join(", ")}]`
          : ""),
    );
    // Heuristic: does the content contain a bare client tool tag the current
    // extractor would miss? (e.g. <list_files> ... </list_files>)
    for (const name of rec.client_tools || []) {
      const re = new RegExp(`<\\s*${name}[\\s>/]`, "i");
      if (
        re.test(content) && !recognized.some((c) => c.function.name === name)
      ) {
        console.log(`  ⚠ content has bare <${name}> tag NOT recognized`);
      }
    }
    console.log(`  --- content (raw model output) ---`);
    console.log(preview(content) || "(empty)");
    if (reasoning) {
      console.log(`  --- reasoning ---`);
      console.log(preview(reasoning, 1200));
    }
    console.log("");
  }
}

main();
