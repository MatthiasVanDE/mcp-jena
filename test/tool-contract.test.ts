// What every tool MUST carry before it may leave the building: four
// annotations with a boolean value, and an input schema that holds up.
//
// This is no formality. A host decides on readOnlyHint whether to ask the user
// for confirmation; with that hint absent the answer is not "no" but "unknown",
// and directories reject a server where that is the case.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toolSchemas, WRITING_TOOLS } from "../src/tools.ts";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

// Every tool by name, so that a missing or renamed tool shows up here instead
// of quietly dropping out of the loop.
const EXPECTED = [
  "execute_sparql_query", "execute_sparql_update", "list_graphs",
  "sparql_query_templates", "list_datasets", "server_status",
  "get_graph", "put_graph", "delete_graph", "load_file",
  "backup", "compact", "task_status",
];

describe("the tool list", () => {
  test("offers exactly the thirteen tools, each once", () => {
    const names = toolSchemas.map(t => t.name);
    assert.deepEqual([...names].sort(), [...EXPECTED].sort());
    assert.equal(new Set(names).size, names.length, "duplicate name in the list");
  });

  test("annotates every writing tool as not read-only", () => {
    for (const name of WRITING_TOOLS) {
      const t = toolSchemas.find(t => t.name === name);
      assert.ok(t, `${name} is in WRITING_TOOLS but not in the list`);
      assert.equal(t!.annotations.readOnlyHint, false,
        `${name} is hidden in read-only mode, yet calls itself read-only`);
    }
  });
});

for (const name of EXPECTED) {
  describe(name, () => {
    const tool = toolSchemas.find(t => t.name === name)!;

    test("carries all four annotations as explicit booleans", () => {
      assert.ok(tool.annotations, `${name} has no annotations block`);
      for (const hint of HINTS) {
        assert.equal(typeof tool.annotations[hint], "boolean",
          `${name}.${hint} is ${JSON.stringify(tool.annotations[hint])}, not a boolean`);
      }
    });

    test("does not call itself read-only and destructive at once", () => {
      if (tool.annotations.readOnlyHint) {
        assert.equal(tool.annotations.destructiveHint, false,
          `${name} only reads, yet calls itself destructive`);
      }
    });

    test("has a usable input schema", () => {
      assert.equal(tool.inputSchema.type, "object");
      const properties = Object.keys((tool.inputSchema as any).properties || {});
      for (const required of ((tool.inputSchema as any).required || [])) {
        assert.ok(properties.includes(required),
          `${name} requires ${required}, but never describes that field`);
      }
      for (const [field, schema] of Object.entries((tool.inputSchema as any).properties || {})) {
        assert.ok((schema as any).description,
          `${name}.${field} has no description`);
      }
    });

    test("has a description that says what it does", () => {
      assert.ok(tool.description && tool.description.length > 40,
        `${name} has barely any description`);
    });
  });
}
