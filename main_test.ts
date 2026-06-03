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
  looksLikeToolMarkerPrefix,
  type Message,
  type OpenAIRequest,
  sanitizeMessageForZai,
  serializeToolCallsForZai,
  shouldFallbackToZaiToolCall,
  type Tool,
  toolBridgeFlushBoundary,
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
