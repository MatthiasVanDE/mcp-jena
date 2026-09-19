// Every tool called once for real, over stdio, against a stand-in Fuseki. This
// is the test that would have caught the bugs this clone started with: queries
// going to an endpoint path that does not exist, and console.log lines
// corrupting the JSON-RPC channel -- because then no usable answer comes back
// here at all.
//
// Runs against dist/, so after a change in src/ build first. `npm test` does
// that itself.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startStub, type StubFuseki } from "./helpers/stub-fuseki.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let stub: StubFuseki;
let client: Client;
let filesDir: string;

/** Calls a tool and insists the server did not answer with an error. */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  assert.notEqual(r.isError, true,
    `${name} returned an error: ${r.content?.[0]?.text}`);
  return String(r.content?.[0]?.text ?? "");
}

before(async () => {
  stub = await startStub();

  filesDir = mkdtempSync(join(tmpdir(), "mcp-jena-test-"));
  writeFileSync(join(filesDir, "example.ttl"),
    '<http://example.org/a> <http://example.org/b> "c" .\n');

  client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "dist", "index.js")],
    env: {
      PATH: process.env.PATH || "",
      JENA_FUSEKI_URL: stub.url,
      DEFAULT_DATASET: "ds",
      JENA_FILES_DIR: filesDir,
      // Explicitly off: otherwise a JENA_READ_ONLY in the environment of
      // whoever runs the tests would make half the tools disappear.
      JENA_READ_ONLY: "",
    },
  }));
});

after(async () => {
  await client?.close();
  await stub?.stop();
});

describe("tools/list over stdio", () => {
  test("yields thirteen tools, each with four annotations", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof (t.annotations as any)?.[hint], "boolean",
          `${t.name} does not offer ${hint} as a boolean`);
      }
    }
  });
});

describe("the reading tools", () => {
  test("execute_sparql_query sends its query to /ds/sparql", async () => {
    const text = await callTool("execute_sparql_query", {
      query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
    });
    assert.match(text, /example\.org\/a/);
    assert.equal(stub.last().path, "/ds/sparql");
    assert.equal(stub.last().method, "POST");
  });

  test("execute_sparql_query writes to out_file inside JENA_FILES_DIR", async () => {
    const text = await callTool("execute_sparql_query", {
      query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
      out_file: "result.json",
    });
    assert.match(text, /result\.json/);
  });

  test("execute_sparql_query refuses an out_file outside JENA_FILES_DIR", async () => {
    const r: any = await client.callTool({
      name: "execute_sparql_query",
      arguments: { query: "SELECT ?s WHERE { ?s ?p ?o }", out_file: "../escaped.json" },
    });
    assert.equal(r.isError, true);
    assert.match(String(r.content[0].text), /outside JENA_FILES_DIR/);
  });

  test("list_graphs returns the graphs that hold triples", async () => {
    const text = await callTool("list_graphs");
    assert.match(text, /example\.org\/graph/);
  });

  test("get_graph fetches Turtle over the Graph Store Protocol", async () => {
    const text = await callTool("get_graph", { graph: "http://example.org/graph" });
    assert.match(text, /example\.org\/a/);
    assert.equal(stub.last().path, "/ds/data");
    assert.equal(stub.last().method, "GET");
  });

  test("list_datasets names the datasets on the server", async () => {
    const text = await callTool("list_datasets");
    assert.match(text, /ds/);
    assert.equal(stub.last().path, "/$/datasets");
  });

  test("server_status reports version and uptime", async () => {
    const text = await callTool("server_status");
    assert.match(text, /5\.6\.0/);
  });

  test("task_status looks the task up by its id", async () => {
    const text = await callTool("task_status", { task_id: "7" });
    assert.match(text, /"7"/);
    assert.equal(stub.last().path, "/$/tasks/7");
  });

  test("sparql_query_templates comes from this code, not from the server", async () => {
    const before = stub.requests.length;
    const text = await callTool("sparql_query_templates", { category: "all" });
    assert.ok(text.length > 100, "no templates came back");
    assert.equal(stub.requests.length, before, "templates must not cost an HTTP call");
  });
});

describe("the writing tools", () => {
  test("execute_sparql_update goes to /ds/update", async () => {
    await callTool("execute_sparql_update", {
      update: 'INSERT DATA { <http://example.org/a> <http://example.org/b> "c" }',
    });
    assert.equal(stub.last().path, "/ds/update");
    assert.match(stub.last().body, /INSERT\+DATA|INSERT%20DATA/);
  });

  test("put_graph replaces with PUT and extends with POST", async () => {
    await callTool("put_graph", {
      graph: "http://example.org/graph",
      content: '<http://example.org/a> <http://example.org/b> "c" .',
      replace: true,
    });
    assert.equal(stub.last().method, "PUT");

    await callTool("put_graph", {
      graph: "http://example.org/graph",
      content: '<http://example.org/a> <http://example.org/b> "d" .',
      replace: false,
    });
    assert.equal(stub.last().method, "POST");
    assert.equal(stub.last().path, "/ds/data");
  });

  test("delete_graph sends DELETE to the graph itself", async () => {
    await callTool("delete_graph", { graph: "http://example.org/graph" });
    assert.equal(stub.last().method, "DELETE");
    assert.match(stub.last().query, /graph=http/);
  });

  test("load_file reads a .ttl from JENA_FILES_DIR and sends it as Turtle", async () => {
    await callTool("load_file", { file: "example.ttl", graph: "http://example.org/graph" });
    assert.equal(stub.last().path, "/ds/data");
    assert.equal(stub.last().headers["content-type"], "text/turtle");
  });

  test("load_file refuses a file outside JENA_FILES_DIR", async () => {
    const r: any = await client.callTool({
      name: "load_file", arguments: { file: "../../etc/hosts" },
    });
    assert.equal(r.isError, true);
    assert.match(String(r.content[0].text), /outside JENA_FILES_DIR/);
  });

  test("backup starts a task and points at task_status", async () => {
    const text = await callTool("backup");
    assert.equal(stub.last().path, "/$/backup/ds");
    assert.match(text, /task_status/);
  });

  test("compact passes delete_old on to the server", async () => {
    await callTool("compact", { delete_old: true });
    assert.equal(stub.last().path, "/$/compact/ds");
    assert.match(stub.last().query, /deleteOld=true/);
  });
});
