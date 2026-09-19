// Wat elk gereedschap MOET aanbieden voordat het de deur uit mag: vier
// annotaties met een booleaanse waarde, en een invoerschema dat klopt.
//
// Dit is geen formaliteit. Een host beslist op readOnlyHint of hij de gebruiker
// om bevestiging vraagt; ontbreekt die hint, dan is het antwoord niet "nee"
// maar "onbekend", en registers weigeren een server waar dat het geval is.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toolSchemas, SCHRIJVENDE_TOOLS } from "../src/tools.ts";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

// Elk gereedschap bij naam, zodat een ontbrekend of hernoemd gereedschap hier
// opvalt in plaats van stilzwijgend uit de lus te verdwijnen.
const VERWACHT = [
  "execute_sparql_query", "execute_sparql_update", "list_graphs",
  "sparql_query_templates", "list_datasets", "server_status",
  "get_graph", "put_graph", "delete_graph", "load_file",
  "backup", "compact", "task_status",
];

describe("de gereedschapslijst", () => {
  test("biedt precies de dertien gereedschappen aan, elk één keer", () => {
    const namen = toolSchemas.map(t => t.name);
    assert.deepEqual([...namen].sort(), [...VERWACHT].sort());
    assert.equal(new Set(namen).size, namen.length, "dubbele naam in de lijst");
  });

  test("elk schrijvend gereedschap is ook als niet-read-only geannoteerd", () => {
    for (const naam of SCHRIJVENDE_TOOLS) {
      const t = toolSchemas.find(t => t.name === naam);
      assert.ok(t, `${naam} staat in SCHRIJVENDE_TOOLS maar niet in de lijst`);
      assert.equal(t!.annotations.readOnlyHint, false,
        `${naam} wordt in read-only modus verborgen, maar heet read-only`);
    }
  });
});

for (const naam of VERWACHT) {
  describe(naam, () => {
    const tool = toolSchemas.find(t => t.name === naam)!;

    test("heeft alle vier de annotaties als expliciete boolean", () => {
      assert.ok(tool.annotations, `${naam} heeft geen annotations-blok`);
      for (const hint of HINTS) {
        assert.equal(typeof tool.annotations[hint], "boolean",
          `${naam}.${hint} is ${JSON.stringify(tool.annotations[hint])}, geen boolean`);
      }
    });

    test("annoteert zichzelf niet tegelijk als read-only en destructief", () => {
      if (tool.annotations.readOnlyHint) {
        assert.equal(tool.annotations.destructiveHint, false,
          `${naam} leest alleen maar heet destructief`);
      }
    });

    test("heeft een bruikbaar invoerschema", () => {
      assert.equal(tool.inputSchema.type, "object");
      const eigenschappen = Object.keys((tool.inputSchema as any).properties || {});
      for (const verplicht of ((tool.inputSchema as any).required || [])) {
        assert.ok(eigenschappen.includes(verplicht),
          `${naam} eist ${verplicht}, maar beschrijft dat veld niet`);
      }
      for (const [veld, schema] of Object.entries((tool.inputSchema as any).properties || {})) {
        assert.ok((schema as any).description,
          `${naam}.${veld} heeft geen beschrijving`);
      }
    });

    test("heeft een beschrijving die zegt wat het doet", () => {
      assert.ok(tool.description && tool.description.length > 40,
        `${naam} heeft nauwelijks een beschrijving`);
    });
  });
}
