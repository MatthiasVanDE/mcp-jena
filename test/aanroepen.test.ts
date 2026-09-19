// Elk gereedschap één keer echt aanroepen, over stdio, tegen een nagemaakte
// Fuseki. Dit is de test die de fouten had gevangen waar deze kloon mee begon:
// queries die naar een endpointpad gingen dat niet bestaat, en console.log-
// regels die het JSON-RPC-kanaal bedierven -- want dan komt er hier geen
// bruikbaar antwoord meer terug.
//
// Draait tegen dist/, dus na een wijziging in src/ eerst `npm run build`.
// `npm test` doet dat zelf.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startStub, type StubFuseki } from "./hulp/stub-fuseki.ts";

const WORTEL = fileURLToPath(new URL("..", import.meta.url));

let stub: StubFuseki;
let client: Client;
let bestandenMap: string;

/** Roept een gereedschap aan en eist dat de server geen fout teruggeeft. */
async function roepAan(naam: string, argumenten: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name: naam, arguments: argumenten });
  assert.notEqual(r.isError, true,
    `${naam} gaf een fout terug: ${r.content?.[0]?.text}`);
  return String(r.content?.[0]?.text ?? "");
}

before(async () => {
  stub = await startStub();

  bestandenMap = mkdtempSync(join(tmpdir(), "mcp-jena-test-"));
  writeFileSync(join(bestandenMap, "voorbeeld.ttl"),
    '<http://example.org/a> <http://example.org/b> "c" .\n');

  client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(WORTEL, "dist", "index.js")],
    env: {
      PATH: process.env.PATH || "",
      JENA_FUSEKI_URL: stub.url,
      DEFAULT_DATASET: "ds",
      JENA_FILES_DIR: bestandenMap,
      // Expliciet uit: anders zou een JENA_READ_ONLY in de omgeving van wie de
      // test draait de helft van de gereedschappen laten verdwijnen.
      JENA_READ_ONLY: "",
    },
  }));
});

after(async () => {
  await client?.close();
  await stub?.stop();
});

describe("tools/list over stdio", () => {
  test("levert dertien gereedschappen, elk met vier annotaties", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof (t.annotations as any)?.[hint], "boolean",
          `${t.name} biedt ${hint} niet als boolean aan`);
      }
    }
  });
});

describe("de lezende gereedschappen", () => {
  test("execute_sparql_query stuurt zijn query naar /ds/sparql", async () => {
    const tekst = await roepAan("execute_sparql_query", {
      query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
    });
    assert.match(tekst, /example\.org\/a/);
    assert.equal(stub.laatste().pad, "/ds/sparql");
    assert.equal(stub.laatste().methode, "POST");
  });

  test("execute_sparql_query schrijft naar out_file binnen JENA_FILES_DIR", async () => {
    const tekst = await roepAan("execute_sparql_query", {
      query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
      out_file: "resultaat.json",
    });
    assert.match(tekst, /resultaat\.json/);
  });

  test("execute_sparql_query weigert een out_file buiten JENA_FILES_DIR", async () => {
    const r: any = await client.callTool({
      name: "execute_sparql_query",
      arguments: { query: "SELECT ?s WHERE { ?s ?p ?o }", out_file: "../ontsnapt.json" },
    });
    assert.equal(r.isError, true);
    assert.match(String(r.content[0].text), /buiten JENA_FILES_DIR/);
  });

  test("list_graphs geeft de grafen terug die triples bevatten", async () => {
    const tekst = await roepAan("list_graphs");
    assert.match(tekst, /example\.org\/graaf/);
  });

  test("get_graph haalt Turtle op via het Graph Store Protocol", async () => {
    const tekst = await roepAan("get_graph", { graph: "http://example.org/graaf" });
    assert.match(tekst, /example\.org\/a/);
    assert.equal(stub.laatste().pad, "/ds/data");
    assert.equal(stub.laatste().methode, "GET");
  });

  test("list_datasets noemt de datasets van de server", async () => {
    const tekst = await roepAan("list_datasets");
    assert.match(tekst, /ds/);
    assert.equal(stub.laatste().pad, "/$/datasets");
  });

  test("server_status meldt versie en uptime", async () => {
    const tekst = await roepAan("server_status");
    assert.match(tekst, /5\.6\.0/);
  });

  test("task_status vraagt de taak op bij zijn nummer", async () => {
    const tekst = await roepAan("task_status", { task_id: "7" });
    assert.match(tekst, /"7"/);
    assert.equal(stub.laatste().pad, "/$/tasks/7");
  });

  test("sparql_query_templates komt uit deze code, niet van de server", async () => {
    const voor = stub.verzoeken.length;
    const tekst = await roepAan("sparql_query_templates", { category: "all" });
    assert.ok(tekst.length > 100, "geen sjablonen teruggekregen");
    assert.equal(stub.verzoeken.length, voor, "sjablonen mogen geen HTTP kosten");
  });
});

describe("de schrijvende gereedschappen", () => {
  test("execute_sparql_update gaat naar /ds/update", async () => {
    await roepAan("execute_sparql_update", {
      update: 'INSERT DATA { <http://example.org/a> <http://example.org/b> "c" }',
    });
    assert.equal(stub.laatste().pad, "/ds/update");
    assert.match(stub.laatste().body, /INSERT\+DATA|INSERT%20DATA/);
  });

  test("put_graph vervangt met PUT en vult aan met POST", async () => {
    await roepAan("put_graph", {
      graph: "http://example.org/graaf",
      content: '<http://example.org/a> <http://example.org/b> "c" .',
      replace: true,
    });
    assert.equal(stub.laatste().methode, "PUT");

    await roepAan("put_graph", {
      graph: "http://example.org/graaf",
      content: '<http://example.org/a> <http://example.org/b> "d" .',
      replace: false,
    });
    assert.equal(stub.laatste().methode, "POST");
    assert.equal(stub.laatste().pad, "/ds/data");
  });

  test("delete_graph stuurt DELETE naar de graaf zelf", async () => {
    await roepAan("delete_graph", { graph: "http://example.org/graaf" });
    assert.equal(stub.laatste().methode, "DELETE");
    assert.match(stub.laatste().query, /graph=http/);
  });

  test("load_file leest een .ttl uit JENA_FILES_DIR en stuurt hem als Turtle", async () => {
    await roepAan("load_file", { file: "voorbeeld.ttl", graph: "http://example.org/graaf" });
    assert.equal(stub.laatste().pad, "/ds/data");
    assert.equal(stub.laatste().headers["content-type"], "text/turtle");
  });

  test("load_file weigert een bestand buiten JENA_FILES_DIR", async () => {
    const r: any = await client.callTool({
      name: "load_file", arguments: { file: "../../etc/hosts" },
    });
    assert.equal(r.isError, true);
    assert.match(String(r.content[0].text), /buiten JENA_FILES_DIR/);
  });

  test("backup start een taak en verwijst naar task_status", async () => {
    const tekst = await roepAan("backup");
    assert.equal(stub.laatste().pad, "/$/backup/ds");
    assert.match(tekst, /task_status/);
  });

  test("compact geeft delete_old door aan de server", async () => {
    await roepAan("compact", { delete_old: true });
    assert.equal(stub.laatste().pad, "/$/compact/ds");
    assert.match(stub.laatste().query, /deleteOld=true/);
  });
});
