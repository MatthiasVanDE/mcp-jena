#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import JenaClient, {
  READ_ONLY, MAX_RESULT_CHARS, DEFAULT_LIMIT, FILES_DIR,
} from "./utils/jena-client.js";
import { toolSchemas, SCHRIJVENDE_TOOLS } from "./tools.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";

// Parse command line arguments
const args = process.argv.slice(2);
let jenaEndpoint = process.env.JENA_FUSEKI_URL || "http://localhost:3030";
let defaultDataset = process.env.DEFAULT_DATASET || "ds";
let jenaUsername = process.env.JENA_USERNAME || "";
let jenaPassword = process.env.JENA_PASSWORD || "";

// Process CLI arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--endpoint" || args[i] === "-e") {
    if (i + 1 < args.length) {
      jenaEndpoint = args[i + 1];
      i++; // Skip the next arg since we used it
    }
  } else if (args[i] === "--dataset" || args[i] === "-d") {
    if (i + 1 < args.length) {
      defaultDataset = args[i + 1];
      i++; // Skip the next arg since we used it
    }
  } else if (args[i] === "--username" || args[i] === "-u") {
    if (i + 1 < args.length) {
      jenaUsername = args[i + 1];
      i++; // Skip the next arg since we used it
    }
  } else if (args[i] === "--password" || args[i] === "-p") {
    if (i + 1 < args.length) {
      jenaPassword = args[i + 1];
      i++; // Skip the next arg since we used it
    }
  }
}

// stderr, niet stdout: over stdout loopt het JSON-RPC-kanaal van MCP.
console.error(`Connecting to Jena endpoint: ${jenaEndpoint}`);
console.error(`Using default dataset: ${defaultDataset}`);
if (jenaUsername) {
  console.error(`Using authentication for user: ${jenaUsername}`);
}

// ---------------------------------------------------------------------------
// Grenzen: aan het antwoord, en aan wat er van schijf mag komen
// ---------------------------------------------------------------------------

/**
 * Kapt een antwoord af dat het contextvenster zou verzwelgen, en zegt erbij
 * hoeveel eraf ging. Zonder deze grens levert een SELECT zonder LIMIT op een
 * dataset van 1599 triples 630 000 tekens op -- gemeten, niet geschat.
 */
function beperk(tekst: string, watHetIs = "antwoord"): string {
  if (tekst.length <= MAX_RESULT_CHARS) return tekst;
  const weg = tekst.length - MAX_RESULT_CHARS;
  return tekst.slice(0, MAX_RESULT_CHARS) +
    `\n\n[AFGEKAPT] Dit ${watHetIs} is ${tekst.length.toLocaleString('nl')} tekens; ` +
    `${weg.toLocaleString('nl')} zijn weggelaten (grens: JENA_MAX_RESULT_CHARS=${MAX_RESULT_CHARS}). ` +
    `Stel een scherpere query, gebruik LIMIT/OFFSET, of schrijf naar een bestand met out_file.`;
}

/**
 * Laat alleen paden binnen JENA_FILES_DIR toe.
 *
 * Een gereedschap dat "een bestand laadt" is een gereedschap dat elk bestand op
 * deze machine naar een server kan sturen. Zonder JENA_FILES_DIR is die hele
 * mogelijkheid uit -- dat is de veilige kant om op te falen.
 */
function veiligPad(pad: string): string {
  if (!FILES_DIR) {
    throw new Error(
      "Bestandstoegang staat uit. Zet JENA_FILES_DIR op de map waaruit gelezen " +
      "en waarheen geschreven mag worden, en herstart de MCP-server.");
  }
  const wortel = resolve(FILES_DIR);
  const doel = resolve(isAbsolute(pad) ? pad : `${wortel}/${pad}`);
  const rel = relative(wortel, doel);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Pad valt buiten JENA_FILES_DIR (${wortel}): ${pad}`);
  }
  return doel;
}

/** Raadt het RDF-mediatype uit de bestandsnaam. */
function mediatype(pad: string): string {
  const e = pad.toLowerCase().split(".").pop() || "";
  const tabel: Record<string, string> = {
    ttl: "text/turtle", turtle: "text/turtle", nt: "application/n-triples",
    trig: "application/trig", nq: "application/n-quads",
    jsonld: "application/ld+json", rdf: "application/rdf+xml", xml: "application/rdf+xml",
  };
  return tabel[e] || "text/turtle";
}

/**
 * Optionele projectkennis: prefixen en de betekenis van de named graphs.
 *
 * Hiermee blijft deze server generiek. Wat het project weet -- dat
 * `urn:echo-mirex:graph/v1#assertions` "wat de detector beweert" bevat -- staat
 * in een JSON-bestand naast de configuratie, niet in deze broncode.
 */
interface Projectcontext {
  prefixes?: Record<string, string>;
  graphs?: { iri: string; betekenis?: string; schrijver?: string }[];
  notes?: string;
}
let context: Projectcontext = {};
const contextBestand = process.env.JENA_CONTEXT_FILE || "";
if (contextBestand) {
  try {
    context = JSON.parse(readFileSync(contextBestand, "utf8"));
    console.error(`Projectcontext geladen uit ${contextBestand}`);
  } catch (e) {
    console.error(`Projectcontext ${contextBestand} niet leesbaar: ${(e as Error).message}`);
  }
}

function contextTekst(): string {
  const delen: string[] = [];
  if (context.prefixes && Object.keys(context.prefixes).length) {
    delen.push("Prefixen van dit project (gebruik ze in plaats van volledige IRI's):\n" +
      Object.entries(context.prefixes).map(([k, v]) => `  PREFIX ${k}: <${v}>`).join("\n"));
  }
  if (context.graphs?.length) {
    delen.push("De named graphs van dit project en wat erin hoort:\n" +
      context.graphs.map(g => `  <${g.iri}>${g.betekenis ? ` -- ${g.betekenis}` : ""}` +
        (g.schrijver ? ` (geschreven door: ${g.schrijver})` : "")).join("\n"));
  }
  if (context.notes) delen.push(context.notes);
  return delen.length ? "\n\n--- PROJECTCONTEXT ---\n" + delen.join("\n\n") : "";
}

// Create server with proper metadata and capabilities
const server = new Server(
  {
    name: "mcp-jena",
    version: "1.0.0",
    description: "MCP server for Apache Jena SPARQL queries",
    // `vendor` en `schemas` zijn hier weg: de huidige MCP-SDK kent die velden
    // niet in Implementation, en tsc weigerde daarop te bouwen. De tools
    // worden hoe dan ook via de ListTools-handler hieronder aangeboden.
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = toolSchemas
    .filter(t => !(READ_ONLY && SCHRIJVENDE_TOOLS.has(t.name)))
    .map(t => ({
      ...t,
      // De projectcontext hangt aan de gereedschappen die SPARQL aannemen:
      // daar heeft het model de prefixen en de graafbetekenissen nodig.
      description: (t.name === "execute_sparql_query" || t.name === "execute_sparql_update")
        ? t.description + contextTekst()
        : t.description,
    }));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // VOORAAN, vóór elke andere tak: een schrijfpoging in read-only modus hoort
  // een duidelijke weigering te zijn en niet een cryptische serverfout. Stond
  // dit verderop, dan ving de keten hieronder execute_sparql_update al af en
  // ging het verzoek alsnog de deur uit.
  if (READ_ONLY && SCHRIJVENDE_TOOLS.has(request.params.name)) {
    return {
      content: [{ type: "text", text:
        `${request.params.name} schrijft, en deze server draait read-only ` +
        `(JENA_READ_ONLY). Haal die instelling weg en herstart de MCP-server om ` +
        `te kunnen schrijven.` }],
      isError: true,
    };
  }

  if (request.params.name === "execute_sparql_query") {
    const query = request.params.arguments?.query as string;
    const dataset = request.params.arguments?.dataset as string | undefined || defaultDataset;
    const limit = request.params.arguments?.limit as number | undefined;
    const outFile = request.params.arguments?.out_file as string | undefined;

    try {
      const client = new JenaClient(jenaEndpoint, dataset, jenaUsername, jenaPassword);
      const result = await client.executeQuery(query, limit);

      // CONSTRUCT en DESCRIBE geven Turtle terug, dus een string. Die door
      // JSON.stringify halen levert één regel vol \n-ontsnappingen op --
      // onleesbaar, en niet meer te kopiëren naar een .ttl-bestand.
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      if (outFile) {
        const pad = veiligPad(outFile);
        mkdirSync(dirname(pad), { recursive: true });
        writeFileSync(pad, text, "utf8");
        const rijen = (result as any)?.results?.bindings?.length;
        return {
          content: [{ type: "text", text:
            `Resultaat weggeschreven naar ${pad} (${text.length.toLocaleString('nl')} tekens` +
            (rijen !== undefined ? `, ${rijen} rijen` : "") + ")." }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: beperk(text, "queryresultaat") }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }
  } 
  else if (request.params.name === "execute_sparql_update") {
    const update = request.params.arguments?.update as string;
    const dataset = request.params.arguments?.dataset as string | undefined || defaultDataset;
    
    try {
      const client = new JenaClient(jenaEndpoint, dataset, jenaUsername, jenaPassword);
      const result = await client.executeUpdate(update);
      
      return {
        content: [{ type: "text", text: result }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }
  }
  else if (request.params.name === "list_graphs") {
    const dataset = request.params.arguments?.dataset as string | undefined || defaultDataset;
    
    try {
      const client = new JenaClient(jenaEndpoint, dataset, jenaUsername, jenaPassword);
      const graphs = await client.listGraphs();
      
      return {
        content: [{ type: "text", text: JSON.stringify(graphs, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }
  }
  else if (request.params.name === "sparql_query_templates") {
    const category = request.params.arguments?.category as string || "all";
    
    try {
      const { SparqlTemplates } = await import("./utils/sparql-templates.js");
      const templates = SparqlTemplates.getTemplates(category);
      
      return {
        content: [{ type: "text", text: JSON.stringify(templates, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }
  }

  // ------------------------------------------------------------------
  // De uitgebouwde gereedschappen
  // ------------------------------------------------------------------
  const arg = request.params.arguments || {};
  const ds = (arg.dataset as string | undefined) || defaultDataset;
  const client = () => new JenaClient(jenaEndpoint, ds, jenaUsername, jenaPassword);
  const ok = (text: string) => ({ content: [{ type: "text", text }], isError: false });
  const fout = (e: unknown) => ({
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  });

  try {
    switch (request.params.name) {
      case "list_datasets": {
        const lijst = await client().listDatasets();
        return ok(lijst.length
          ? JSON.stringify(lijst, null, 2)
          : "Deze server heeft geen enkele dataset.");
      }

      case "server_status":
        return ok(beperk(JSON.stringify(await client().serverStatus(), null, 2), "statusoverzicht"));

      case "get_graph": {
        const turtle = await client().getGraph(arg.graph as string | undefined);
        if (arg.out_file) {
          const pad = veiligPad(arg.out_file as string);
          mkdirSync(dirname(pad), { recursive: true });
          writeFileSync(pad, turtle, "utf8");
          return ok(`Graaf weggeschreven naar ${pad} (${turtle.length.toLocaleString('nl')} tekens).`);
        }
        return ok(beperk(turtle, "graafexport"));
      }

      case "put_graph": {
        const heeftBestand = typeof arg.file === "string" && arg.file;
        const heeftInhoud = typeof arg.content === "string" && arg.content;
        if (heeftBestand === heeftInhoud) {
          throw new Error("Geef precies één van `file` of `content`.");
        }
        const inhoud = heeftBestand
          ? readFileSync(veiligPad(arg.file as string), "utf8")
          : (arg.content as string);
        const type = (arg.content_type as string | undefined)
          || (heeftBestand ? mediatype(arg.file as string) : "text/turtle");
        const vervang = arg.replace !== false;
        return ok(await client().writeGraph(inhoud, arg.graph as string | undefined, vervang, type));
      }

      case "delete_graph":
        return ok(await client().deleteGraph(arg.graph as string));

      case "load_file": {
        const pad = veiligPad(arg.file as string);
        const inhoud = readFileSync(pad, "utf8");
        const vervang = arg.replace === true;
        const melding = await client().writeGraph(
          inhoud, arg.graph as string | undefined, vervang, mediatype(pad));
        return ok(`${melding}\nBron: ${pad} (${inhoud.length.toLocaleString('nl')} tekens).`);
      }

      case "backup": {
        const taak = await client().backup(arg.dataset as string | undefined);
        return ok(`Backup gestart voor ${ds}.\n${JSON.stringify(taak, null, 2)}\n\n` +
                  `Volg hem met task_status.`);
      }

      case "compact": {
        const taak = await client().compact(arg.dataset as string | undefined, arg.delete_old === true);
        return ok(`Compactie gestart voor ${ds}.\n${JSON.stringify(taak, null, 2)}\n\n` +
                  `Volg hem met task_status.`);
      }

      case "task_status":
        return ok(JSON.stringify(await client().taskStatus(arg.task_id as string), null, 2));
    }
  } catch (e) {
    return fout(e);
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error); 