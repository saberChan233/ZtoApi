// Unit tests for the tool-call bridge and stream-sieve helpers.
//
// Run with: deno test --allow-env --allow-read main_test.ts
//
// These tests guard the behavioral fixes that make ZtoApi safe to drive from
// agentic coding clients (pi / Claude Code / Codex):
//   1. The bridge must NOT fabricate tool calls by default (agent stays in
//      control of planning).
//   2. Forced tool calls fill arguments from the JSON schema only -- never
//      hard-coded project paths / shell commands / grep patterns.
//   3. The streaming sieve emits prose smoothly but never leaks a partial
//      tool-call marker.
//   4. OpenAI tool messages / assistant tool_calls round-trip into Z.ai text.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildFallbackArgumentsForTool,
  buildZaiFallbackToolCalls,
  buildZaiToolCallBridgeInstruction,
  buildZaiToolCallBridgeReminder,
  extractZaiBridgeToolCalls,
  extractZaiNativeXmlToolCalls,
  injectZaiToolCallBridgeInstruction,
  looksLikeToolMarkerPrefix,
  type Message,
  type OpenAIRequest,
  sanitizeMessageForZai,
  serializeToolCallsForZai,
  shouldFallbackToZaiToolCall,
  type Tool,
  toolBridgeFlushBoundary,
  toolTagMarkerPrefixes,
} from "./main.ts";

const readFileTool: Tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_bytes: { type: "number" },
      },
      required: ["path"],
    },
  },
};

const bashTool: Tool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

function req(partial: Partial<OpenAIRequest>): OpenAIRequest {
  return {
    model: "glm-4.6",
    messages: [{ role: "user", content: "分析当前项目并检查文件结构" }],
    tools: [readFileTool, bashTool],
    ...partial,
  };
}

// --- Fix A: no fabrication by default -------------------------------------

Deno.test("shouldFallbackToZaiToolCall: auto tool_choice never fabricates", () => {
  // Even with an inspection-style prompt, default (opt-in disabled) must not
  // synthesize a tool call -- the model decides.
  assertEquals(
    shouldFallbackToZaiToolCall(req({ tool_choice: "auto" })),
    false,
  );
  assertEquals(shouldFallbackToZaiToolCall(req({})), false);
  assertEquals(buildZaiFallbackToolCalls(req({ tool_choice: "auto" })), []);
});

Deno.test("shouldFallbackToZaiToolCall: no tools or tool_choice=none", () => {
  assertEquals(
    shouldFallbackToZaiToolCall(req({ tools: [], tool_choice: "required" })),
    false,
  );
  assertEquals(
    shouldFallbackToZaiToolCall(req({ tool_choice: "none" })),
    false,
  );
});

Deno.test("buildZaiFallbackToolCalls: tool_choice=required picks a tool with schema args", () => {
  const calls = buildZaiFallbackToolCalls(req({ tool_choice: "required" }));
  assertEquals(calls.length, 1);
  assertEquals(calls[0].function.name, "read_file");
  const args = JSON.parse(calls[0].function.arguments);
  // Only the schema-required field, with a schema default -- no hard-coded path.
  assertEquals(args, { path: "" });
});

Deno.test("buildZaiFallbackToolCalls: forced specific tool is honored", () => {
  const calls = buildZaiFallbackToolCalls(
    req({ tool_choice: { type: "function", function: { name: "bash" } } }),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].function.name, "bash");
  const args = JSON.parse(calls[0].function.arguments);
  assertEquals(args, { command: "" });
});

Deno.test("buildFallbackArgumentsForTool: never injects hard-coded project values", () => {
  const args = buildFallbackArgumentsForTool(readFileTool);
  assertEquals(args, { path: "" });
  const serialized = JSON.stringify(buildFallbackArgumentsForTool(bashTool));
  assert(!serialized.includes("main.ts"));
  assert(!serialized.includes("TODO"));
  assert(!serialized.includes("rg "));
  assert(!serialized.includes("ls -la"));
});

Deno.test("buildFallbackArgumentsForTool: respects enum/default/type", () => {
  const tool: Tool = {
    type: "function",
    function: {
      name: "t",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "slow"] },
          retries: { type: "integer", default: 3 },
          flag: { type: "boolean" },
        },
        required: ["mode", "retries", "flag"],
      },
    },
  };
  assertEquals(buildFallbackArgumentsForTool(tool), {
    mode: "fast",
    retries: 3,
    flag: false,
  });
});

// --- Fix B: streaming sieve boundary --------------------------------------

Deno.test("toolBridgeFlushBoundary: plain prose is fully emittable", () => {
  const text = "Here is a normal answer with no tool markup at all.";
  assertEquals(toolBridgeFlushBoundary(text), text.length);
});

Deno.test("toolBridgeFlushBoundary: holds from a tool-call marker start", () => {
  const prose = "Let me check that. ";
  const buf = prose + '<tool_calls><invoke name="read_file">';
  assertEquals(toolBridgeFlushBoundary(buf), prose.length);
});

Deno.test("toolBridgeFlushBoundary: holds a partial marker arriving across chunks", () => {
  const prose = "thinking ";
  // "<inv" could become "<invoke" -- must be held, not streamed.
  assertEquals(toolBridgeFlushBoundary(prose + "<inv"), prose.length);
});

Deno.test("toolBridgeFlushBoundary: benign angle/brace text is not held", () => {
  assertEquals(
    toolBridgeFlushBoundary("if a < b then"),
    "if a < b then".length,
  );
  assertEquals(
    toolBridgeFlushBoundary('config {"name":"x"}'),
    'config {"name":"x"}'.length,
  );
});

Deno.test("looksLikeToolMarkerPrefix: json tool_calls and fences", () => {
  assert(looksLikeToolMarkerPrefix('{"tool_calls"'));
  assert(looksLikeToolMarkerPrefix('{"too'));
  assert(looksLikeToolMarkerPrefix("```json"));
  assert(looksLikeToolMarkerPrefix("```"));
  assert(!looksLikeToolMarkerPrefix('{"name":"x"}'));
});

// --- Multi-turn tool context backfill -------------------------------------

Deno.test("sanitizeMessageForZai: tool result becomes a user message", () => {
  const msg: Message = {
    role: "tool",
    name: "read_file",
    tool_call_id: "call_1",
    content: "file contents here",
  };
  const out = sanitizeMessageForZai(msg);
  assertEquals(out.role, "user");
  assert(String(out.content).startsWith("Tool result (read_file):"));
  assert(String(out.content).includes("file contents here"));
});

Deno.test("sanitizeMessageForZai: assistant tool_calls are serialized into text", () => {
  const msg: Message = {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    }],
  };
  const out = sanitizeMessageForZai(msg);
  assertEquals(out.role, "assistant");
  assert(String(out.content).includes("Assistant requested tool calls:"));
  assert(String(out.content).includes('bash({"command":"ls"})'));
});

Deno.test("serializeToolCallsForZai: renders name and arguments", () => {
  assertEquals(serializeToolCallsForZai(), "");
  const text = serializeToolCallsForZai([{
    id: "1",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"a.ts"}' },
  }]);
  assertEquals(text, '- read_file({"path":"a.ts"})');
});

// --- Kilo fix: bridge instruction placement + strength --------------------
//
// Agentic clients (Kilo, pi, Claude Code) prepend a very large system prompt.
// A single leading bridge instruction gets drowned out and the model narrates
// ("I will first look at the directory structure") and stops without emitting a
// tool-call payload. The instruction must forbid that and be repeated as the
// most-recent message so the model reliably emits a tool call.

Deno.test("injectZaiToolCallBridgeInstruction: wraps history with leading + trailing system messages", () => {
  const history: Message[] = [
    { role: "system", content: "KILO_HUGE_SYSTEM_PROMPT" },
    { role: "user", content: "分析项目，找出项目缺陷" },
  ];
  const out = injectZaiToolCallBridgeInstruction(
    history,
    req({ messages: history, tool_choice: "auto" }),
  );
  // Leading instruction is first, original history preserved in order, and a
  // high-salience reminder is the LAST message before generation.
  assertEquals(out.length, history.length + 2);
  assertEquals(out[0].role, "system");
  assert(
    String(out[0].content).includes("tool-call bridge"),
  );
  assertEquals(out[1].content, "KILO_HUGE_SYSTEM_PROMPT");
  assertEquals(out[2].content, "分析项目，找出项目缺陷");
  const last = out[out.length - 1];
  assertEquals(last.role, "system");
  assert(String(last.content).includes("[tool-call bridge] Reminder"));
});

Deno.test("injectZaiToolCallBridgeInstruction: no-op without tools / tool_choice=none", () => {
  const history: Message[] = [{ role: "user", content: "hi" }];
  assertEquals(
    injectZaiToolCallBridgeInstruction(
      history,
      req({ messages: history, tools: [] }),
    ),
    history,
  );
  assertEquals(
    injectZaiToolCallBridgeInstruction(
      history,
      req({ messages: history, tool_choice: "none" }),
    ),
    history,
  );
});

Deno.test("bridge instruction forbids announcing actions without calling a tool", () => {
  const text = buildZaiToolCallBridgeInstruction(req({ tool_choice: "auto" }));
  // The exact failure mode reported from Kilo must be explicitly forbidden.
  assert(text.includes("FORBIDDEN"));
  assert(text.toLowerCase().includes("never announce"));
  assert(text.includes("我先看下目录结构"));
  // The native XML-tag shape (using a real tool name) is the documented format,
  // plus the JSON shape; every tool name is listed.
  assert(text.includes("<read_file>"));
  assert(text.includes('{"tool_calls"'));
  assert(text.includes("read_file"));
  assert(text.includes("bash"));
  // Must pin the model to the exact client tool names and forbid invented ones.
  assert(text.includes("[read_file, bash]"));
  assert(text.includes("list_files"));
});

Deno.test("bridge instruction + reminder forbid invented tool names and pin the list", () => {
  const reminder = buildZaiToolCallBridgeReminder(req({ tool_choice: "auto" }));
  // Reminder (last, highest-salience message) must enumerate exact names, show
  // the native-tag format with a real tool, and forbid Cline-style aliases.
  assert(reminder.includes("[read_file, bash]"));
  assert(reminder.includes("<read_file>"));
  assert(reminder.includes("list_files"));
});

Deno.test("bridge reminder names the forced tool when tool_choice is an object", () => {
  const forced = buildZaiToolCallBridgeReminder(
    req({ tool_choice: { type: "function", function: { name: "bash" } } }),
  );
  assert(forced.includes("must call the tool named bash"));
  // Auto mode omits the forced-tool line but still demands a payload-or-answer.
  const auto = buildZaiToolCallBridgeReminder(req({ tool_choice: "auto" }));
  assert(!auto.includes("must call the tool named"));
  assert(auto.includes("EITHER exactly one tool-call payload"));
});

// --- Native client-XML tool tags (Cline / Roo / Kilo shape) ----------------

Deno.test("extractZaiNativeXmlToolCalls: recognizes a bare client tool tag", () => {
  // The model emits the tool name directly as an XML element (the format Kilo's
  // own system prompt documents), instead of <tool_calls><invoke>.
  const calls = extractZaiNativeXmlToolCalls(
    "Let me check the files first.\n<read_file><path>main.ts</path></read_file>",
    [readFileTool, bashTool],
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].function.name, "read_file");
  assertEquals(JSON.parse(calls[0].function.arguments), { path: "main.ts" });
});

Deno.test("extractZaiNativeXmlToolCalls: parses multiple params and a second tag", () => {
  const calls = extractZaiNativeXmlToolCalls(
    "<bash><command>ls -la</command></bash>",
    [readFileTool, bashTool],
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].function.name, "bash");
  assertEquals(JSON.parse(calls[0].function.arguments), { command: "ls -la" });
});

Deno.test("extractZaiNativeXmlToolCalls: ignores tags that are not client tools", () => {
  // <list_files> is NOT one of the client's tools, so it must NOT be coerced
  // into a tool call (avoids hijacking with a name the client cannot execute).
  assertEquals(
    extractZaiNativeXmlToolCalls(
      "首先，让我查看目录结构。\n<list_files><path>.</path></list_files>",
      [readFileTool, bashTool],
    ),
    [],
  );
  // No tools => never coerce (prevents false positives on prose with angle tags).
  assertEquals(
    extractZaiNativeXmlToolCalls("<read_file><path>x</path></read_file>", []),
    [],
  );
});

Deno.test("extractZaiBridgeToolCalls: native XML path is reached after markup/JSON", () => {
  // End-to-end: the unified extractor now also recognizes the native tag shape.
  const calls = extractZaiBridgeToolCalls(
    "<read_file><path>README.md</path></read_file>",
    [readFileTool, bashTool],
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].function.name, "read_file");
  // The canonical <tool_calls><invoke> shape still wins and is unchanged.
  const invoke = extractZaiBridgeToolCalls(
    '<tool_calls><invoke name="bash"><parameter name="command">pwd</parameter></invoke></tool_calls>',
    [readFileTool, bashTool],
  );
  assertEquals(invoke[0].function.name, "bash");
});

Deno.test("toolTagMarkerPrefixes + leak guard hold a partial native tag", () => {
  const prefixes = toolTagMarkerPrefixes(["read_file", "bash"]);
  assert(prefixes.includes("<read_file"));
  // A partial bare tag arriving across chunks must be held, not streamed.
  assert(looksLikeToolMarkerPrefix("<read_fi", prefixes));
  // Without the client tool prefixes, the old guard would leak it as text.
  assertEquals(looksLikeToolMarkerPrefix("<read_fi"), false);
  // Prose before a native tag streams up to the tag, which is held back.
  const buf = "Let me check first <read_file><path>";
  const boundary = toolBridgeFlushBoundary(buf, prefixes);
  assertEquals(buf.slice(0, boundary), "Let me check first ");
});
