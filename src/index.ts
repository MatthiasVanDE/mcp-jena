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

// Define the tool schemas upfront
const toolSchemas = [
  {
    name: "execute_sparql_query",
    description: `Execute a SPARQL query against an Apache Jena dataset.

SPARQL (SPARQL Protocol and RDF Query Language) is a query language for RDF data.

Key SPARQL Query Forms:
- SELECT: Returns variable bindings as a table
- CONSTRUCT: Returns RDF triples  
- ASK: Returns true/false
- DESCRIBE: Returns RDF description of resources

Basic SPARQL Syntax:
- PREFIX declarations: PREFIX ex: <http://example.org/>
- WHERE clause with triple patterns: ?subject ?predicate ?object
- Optional patterns: OPTIONAL { ?s ?p ?o }
- Filters: FILTER(?var > 10)
- Graph patterns: GRAPH <uri> { ?s ?p ?o }
- Property paths: ?s ex:knows/ex:friend ?o (sequence), ?s ex:knows* ?o (zero or more)

Common Query Templates:
1. Basic exploration: SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10
2. Count triples: SELECT (COUNT(*) as ?count) WHERE { ?s ?p ?o }
3. List types: SELECT DISTINCT ?type WHERE { ?s a ?type }
4. Property path (friends of friends): SELECT ?person ?friend WHERE { ?person foaf:knows/foaf:knows ?friend }
5. Optional properties: SELECT ?s ?name WHERE { ?s a ex:Person . OPTIONAL { ?s foaf:name ?name } }
6. Named graph query: SELECT ?s ?p ?o FROM NAMED <graph> WHERE { GRAPH <graph> { ?s ?p ?o } }
7. Filter by value: SELECT ?s WHERE { ?s ex:age ?age . FILTER(?age > 18) }

Property Path Operators:
- / (sequence): ?s foaf:knows/foaf:name ?name
- | (alternative): ?s (foaf:name|rdfs:label) ?name  
- * (zero or more): ?s foaf:knows* ?connected
- + (one or more): ?s ex:partOf+ ?container
- ? (zero or one): ?s foaf:knows? ?maybeKnown
- ^ (inverse): ?s ^ex:hasChild ?parent (equivalent to ?parent ex:hasChild ?s)
- ! (negation): ?s !(rdf:type) ?notType`,
    inputSchema: {
      type: "object",
      properties: {
        query: { 
          type: "string",
          description: "The SPARQL query to execute. Must be valid SPARQL syntax (SELECT, CONSTRUCT, ASK, or DESCRIBE). Use property paths for complex graph navigation.",
        },
        dataset: { 
          type: "string",
          description: "Dataset name. If not provided, uses the default dataset.",
        },
        limit: {
          type: "number",
          description:
            "Maximum rows for a SELECT that has no LIMIT of its own. Defaults to " +
            "JENA_DEFAULT_LIMIT. Pass 0 to disable -- but be warned: an unbounded " +
            "SELECT over a small dataset can return hundreds of thousands of characters.",
        },
        out_file: {
          type: "string",
          description:
            "Write the result to this file (inside JENA_FILES_DIR) instead of returning " +
            "it. Use for large results: the tool then returns only the path and the size.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "execute_sparql_update",
    description: `Execute a SPARQL update query against an Apache Jena dataset.

SPARQL Update Operations:
- INSERT DATA: Add triples to the dataset
- DELETE DATA: Remove specific triples  
- INSERT/DELETE WHERE: Conditional insert/delete based on patterns
- LOAD/CLEAR: Load/clear entire graphs
- CREATE/DROP: Manage graph lifecycle

IMPORTANT on TDB2 (the storage this server talks to): CREATE GRAPH <g> on its
own does NOT make a graph that anything can see. It returns 200, but the graph
only starts existing once it holds at least one triple -- list_graphs will not
show it, and GET /data?graph=g returns 404. To create a graph, insert into it:
  INSERT DATA { GRAPH <g> { <s> <p> <o> } }
That single statement creates the graph and fills it; no CREATE needed.

Basic Update Syntax:
- INSERT DATA { <subject> <predicate> <object> }
- DELETE DATA { <subject> <predicate> <object> }
- INSERT { ?s <new:prop> "value" } WHERE { ?s <old:prop> ?o }
- DELETE { ?s <old:prop> ?o } WHERE { ?s <old:prop> ?o }
- CLEAR GRAPH <graph-uri>

Example Updates:
1. Insert data: INSERT DATA { <ex:person1> foaf:name "John" ; ex:age 25 }
2. Delete data: DELETE DATA { <ex:person1> ex:age 25 }
3. Conditional update: DELETE { ?p ex:status "pending" } INSERT { ?p ex:status "active" } WHERE { ?p ex:status "pending" }
4. Insert with graph: INSERT DATA { GRAPH <ex:metadata> { <ex:dataset1> dcterms:created "2024-01-01"^^xsd:date } }
5. Clear graph: CLEAR GRAPH <ex:temporary>`,
    inputSchema: {
      type: "object",
      properties: {
        update: { 
          type: "string",
          description: "The SPARQL update query to execute. Must be valid SPARQL update syntax (INSERT, DELETE, LOAD, CLEAR, CREATE, DROP).",
        },
        dataset: { 
          type: "string",
          description: "Dataset name. If not provided, uses the default dataset.",
        },
      },
      required: ["update"],
    },
  },
  {
    name: "list_graphs",
    description: `List all available named graphs in an Apache Jena dataset.

Lists graphs that hold at least one triple. On TDB2 that is the same set as
"all graphs that exist": an empty graph -- one just made with CREATE GRAPH, say --
is indistinguishable from a graph that was never made. If a graph you created is
missing from this list, it has no triples yet.

Named graphs in RDF provide context and provenance for triples. Each graph is identified by a URI.
This tool helps discover what data contexts are available in your dataset.

Common Graph Patterns:
- Default graph (unnamed): Contains triples not in any specific graph
- Named graphs: <http://example.org/graph1>, <http://data.gov/dataset1>  
- Metadata graphs: Often contain information about other graphs
- Versioned graphs: <http://data.org/v1>, <http://data.org/v2>

Use Case Examples:
- Data provenance: Track where data came from
- Temporal data: Different time periods in separate graphs
- Access control: Different permissions per graph
- Data quality: Separate validated vs raw data`,
    inputSchema: {
      type: "object",
      properties: {
        dataset: { 
          type: "string",
          description: "Dataset name. If not provided, uses the default dataset.",
        },
      },
    },
  },
  {
    name: "sparql_query_templates",
    description: `Get SPARQL query templates for common knowledge graph exploration patterns.

This tool provides pre-built SPARQL query templates covering:
- Basic data exploration and statistics
- Property path navigation for complex relationships
- Knowledge graph analysis patterns
- Data validation and quality checks
- Schema discovery and documentation

Templates include explanations and can be customized with your specific URIs and requirements.`,
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["exploration", "property-paths", "statistics", "validation", "schema", "all"],
          description: "Category of templates to retrieve. 'all' returns all available templates.",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "list_datasets",
    description: `List the datasets on this Fuseki server, with their endpoints.

Use this FIRST when a query fails with HTTP 405 or 404. Fuseki answers 405 -- not
404 -- for a dataset that does not exist, which is easy to mistake for a wrong
path. This tool shows what actually exists and which endpoint names each dataset
offers (a dataset that names its own endpoints in a config file often has only
"sparql", not "query").`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "server_status",
    description: `Version, uptime and per-dataset statistics of the Fuseki server.

Read-only. Useful to confirm you are talking to the server you think you are,
and to see request counts per dataset.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_graph",
    description: `Fetch one named graph in full, as Turtle, via the Graph Store Protocol.

This is one HTTP call and does not go through the SPARQL query parser, so it is
the right way to read a whole graph. A CONSTRUCT would produce the same triples
but has to be parsed and serialised as a query result.

NOTE on 404: an empty graph and a non-existent graph are the same thing in TDB2,
and both answer 404. That is not an endpoint error.

For anything sizeable, pass out_file -- a 30 kB graph is already ~8000 tokens.`,
    inputSchema: {
      type: "object",
      properties: {
        graph: { type: "string", description: "Graph IRI. Omit for the default graph." },
        dataset: { type: "string", description: "Dataset name; defaults to the configured one." },
        out_file: { type: "string", description: "Write the Turtle here (inside JENA_FILES_DIR) instead of returning it." },
      },
    },
  },
  {
    name: "put_graph",
    description: `Replace (PUT) or extend (POST) one named graph with RDF content.

replace=true makes the graph exactly the content given -- everything that was in
it is gone. replace=false adds to what is there.

This is how a schema layer is synchronised: one PUT per named graph, so that
updating one module cannot wipe another. Content comes either inline (content)
or from a file (file, inside JENA_FILES_DIR) -- prefer the file for anything
beyond a few triples, so the RDF does not have to pass through the context.`,
    inputSchema: {
      type: "object",
      properties: {
        graph: { type: "string", description: "Graph IRI. Omit for the default graph." },
        content: { type: "string", description: "RDF as text. Mutually exclusive with file." },
        file: { type: "string", description: "Path inside JENA_FILES_DIR. Mutually exclusive with content." },
        content_type: { type: "string", description: "Media type; inferred from the file extension when a file is used (default text/turtle)." },
        replace: { type: "boolean", description: "true = PUT (replace the graph), false = POST (add to it). Default true." },
        dataset: { type: "string", description: "Dataset name; defaults to the configured one." },
      },
    },
  },
  {
    name: "delete_graph",
    description: `Delete one named graph and everything in it. Irreversible.

Consider running backup first. Deleting a graph that is already empty answers
404, which here means "there was nothing" rather than "something went wrong".`,
    inputSchema: {
      type: "object",
      properties: {
        graph: { type: "string", description: "Graph IRI to delete." },
        dataset: { type: "string", description: "Dataset name; defaults to the configured one." },
      },
      required: ["graph"],
    },
  },
  {
    name: "load_file",
    description: `Load an RDF file from disk into a dataset, without it passing through the context.

Takes .ttl, .nt, .trig, .nq, .jsonld or .rdf from inside JENA_FILES_DIR. A TriG
or N-Quads file carries its own graph names; for triple formats you can target
one graph with the graph argument.

This exists because the alternative -- turning a 44 kB ontology into one big
INSERT DATA statement -- costs about 11 000 tokens and is fragile.`,
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path inside JENA_FILES_DIR." },
        graph: { type: "string", description: "Target graph IRI. Omit for the default graph, or when the file carries its own graph names (TriG/N-Quads)." },
        replace: { type: "boolean", description: "true = replace that graph, false = add to it. Default false." },
        dataset: { type: "string", description: "Dataset name; defaults to the configured one." },
      },
      required: ["file"],
    },
  },
  {
    name: "backup",
    description: `Start a server-side backup of a dataset. Returns the task id.

The backup is written on the server (Fuseki's own backups directory) and runs in
the background; poll it with task_status. Do this before a destructive update --
there is no undo for DROP GRAPH.`,
    inputSchema: {
      type: "object",
      properties: { dataset: { type: "string", description: "Dataset name; defaults to the configured one." } },
    },
  },
  {
    name: "compact",
    description: `Compact a TDB2 dataset: reclaim space left by earlier versions of the data.

Runs in the background; poll with task_status. delete_old removes the previous
copy once compaction succeeds -- that frees the most space and is what you
normally want, but it is irreversible.`,
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name; defaults to the configured one." },
        delete_old: { type: "boolean", description: "Delete the pre-compaction copy. Default false." },
      },
    },
  },
  {
    name: "task_status",
    description: `The state of a background task started by backup or compact.

Returns its start time, and "finished" once it is done.`,
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "Task id from backup or compact." } },
      required: ["task_id"],
    },
  },
];
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

// Welke gereedschappen SCHRIJVEN. In read-only modus worden ze niet aangeboden.
// Niet aanbieden is strenger dan weigeren bij aanroep: wat niet in de lijst
// staat, probeert een model niet.
const SCHRIJVENDE_TOOLS = new Set([
  "execute_sparql_update", "put_graph", "delete_graph", "load_file", "compact",
]);

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