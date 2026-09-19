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
import { toolSchemas, WRITING_TOOLS } from "./tools.js";
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

// stderr, not stdout: stdout carries the JSON-RPC channel of MCP.
console.error(`Connecting to Jena endpoint: ${jenaEndpoint}`);
console.error(`Using default dataset: ${defaultDataset}`);
if (jenaUsername) {
  console.error(`Using authentication for user: ${jenaUsername}`);
}

// ---------------------------------------------------------------------------
// Bounds: on the response, and on what may come off disk
// ---------------------------------------------------------------------------

/**
 * Truncates a response that would swamp the context window, and says how much
 * was cut. Without this bound, a SELECT without LIMIT on a dataset of 1599
 * triples yields 630,000 characters -- measured, not estimated.
 */
function truncate(text: string, whatItIs = "response"): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const cut = text.length - MAX_RESULT_CHARS;
  return text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[TRUNCATED] This ${whatItIs} is ${text.length.toLocaleString('en')} characters; ` +
    `${cut.toLocaleString('en')} were left out (limit: JENA_MAX_RESULT_CHARS=${MAX_RESULT_CHARS}). ` +
    `Narrow the query, use LIMIT/OFFSET, or write to a file with out_file.`;
}

/**
 * Admits only paths inside JENA_FILES_DIR.
 *
 * A tool that "loads a file" is a tool that can send any file on this machine
 * to a server. Without JENA_FILES_DIR that possibility is off altogether --
 * which is the safe side to fail on.
 */
function safePath(path: string): string {
  if (!FILES_DIR) {
    throw new Error(
      "File access is off. Set JENA_FILES_DIR to the directory that may be " +
      "read from and written to, and restart the MCP server.");
  }
  const root = resolve(FILES_DIR);
  const target = resolve(isAbsolute(path) ? path : `${root}/${path}`);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path falls outside JENA_FILES_DIR (${root}): ${path}`);
  }
  return target;
}

/** Guesses the RDF media type from the file name. */
function mediaType(path: string): string {
  const e = path.toLowerCase().split(".").pop() || "";
  const table: Record<string, string> = {
    ttl: "text/turtle", turtle: "text/turtle", nt: "application/n-triples",
    trig: "application/trig", nq: "application/n-quads",
    jsonld: "application/ld+json", rdf: "application/rdf+xml", xml: "application/rdf+xml",
  };
  return table[e] || "text/turtle";
}

/**
 * Optional project knowledge: prefixes, and what the named graphs mean.
 *
 * This is what keeps the server generic. What a project knows -- that
 * `urn:example:graph/v1#assertions` holds "what the detector claims" -- lives in
 * a JSON file beside the configuration, not in this source.
 */
interface ProjectContext {
  prefixes?: Record<string, string>;
  graphs?: { iri: string; meaning?: string; writtenBy?: string }[];
  notes?: string;
}
let context: ProjectContext = {};
const contextFile = process.env.JENA_CONTEXT_FILE || "";
if (contextFile) {
  try {
    context = JSON.parse(readFileSync(contextFile, "utf8"));
    console.error(`Project context loaded from ${contextFile}`);
  } catch (e) {
    console.error(`Project context ${contextFile} is not readable: ${(e as Error).message}`);
  }
}

function contextText(): string {
  const parts: string[] = [];
  if (context.prefixes && Object.keys(context.prefixes).length) {
    parts.push("Prefixes of this project (use them instead of full IRIs):\n" +
      Object.entries(context.prefixes).map(([k, v]) => `  PREFIX ${k}: <${v}>`).join("\n"));
  }
  if (context.graphs?.length) {
    parts.push("The named graphs of this project and what belongs in them:\n" +
      context.graphs.map(g => `  <${g.iri}>${g.meaning ? ` -- ${g.meaning}` : ""}` +
        (g.writtenBy ? ` (written by: ${g.writtenBy})` : "")).join("\n"));
  }
  if (context.notes) parts.push(context.notes);
  return parts.length ? "\n\n--- PROJECT CONTEXT ---\n" + parts.join("\n\n") : "";
}

// Create server with proper metadata and capabilities
const server = new Server(
  {
    name: "mcp-jena",
    version: "1.1.0",
    description: "MCP server for Apache Jena SPARQL queries",
    // `vendor` and `schemas` are gone from here: the current MCP SDK does not
    // know those fields on Implementation, and tsc refused to build on them.
    // The tools are offered through the ListTools handler below regardless.
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = toolSchemas
    .filter(t => !(READ_ONLY && WRITING_TOOLS.has(t.name)))
    .map(t => ({
      ...t,
      // The project context hangs off the tools that take SPARQL: that is where
      // the model needs the prefixes and the meaning of each graph.
      description: (t.name === "execute_sparql_query" || t.name === "execute_sparql_update")
        ? t.description + contextText()
        : t.description,
    }));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // UP FRONT, before any other branch: an attempt to write in read-only mode
  // should be a clear refusal, not a cryptic server error. Further down, the
  // chain below would already have caught execute_sparql_update and the request
  // would have gone out after all.
  if (READ_ONLY && WRITING_TOOLS.has(request.params.name)) {
    return {
      content: [{ type: "text", text:
        `${request.params.name} writes, and this server runs read-only ` +
        `(JENA_READ_ONLY). Remove that setting and restart the MCP server to be ` +
        `able to write.` }],
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

      // CONSTRUCT and DESCRIBE return Turtle, so a string. Running that through
      // JSON.stringify yields one line full of \n escapes -- unreadable, and no
      // longer copyable into a .ttl file.
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      if (outFile) {
        const path = safePath(outFile);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, "utf8");
        const rows = (result as any)?.results?.bindings?.length;
        return {
          content: [{ type: "text", text:
            `Result written to ${path} (${text.length.toLocaleString('en')} characters` +
            (rows !== undefined ? `, ${rows} rows` : "") + ")." }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: truncate(text, "query result") }],
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
  // The tools added on top of upstream
  // ------------------------------------------------------------------
  const arg = request.params.arguments || {};
  const ds = (arg.dataset as string | undefined) || defaultDataset;
  const client = () => new JenaClient(jenaEndpoint, ds, jenaUsername, jenaPassword);
  const ok = (text: string) => ({ content: [{ type: "text", text }], isError: false });
  const fail = (e: unknown) => ({
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  });

  try {
    switch (request.params.name) {
      case "list_datasets": {
        const list = await client().listDatasets();
        return ok(list.length
          ? JSON.stringify(list, null, 2)
          : "This server has no datasets at all.");
      }

      case "server_status":
        return ok(truncate(JSON.stringify(await client().serverStatus(), null, 2), "status overview"));

      case "get_graph": {
        const turtle = await client().getGraph(arg.graph as string | undefined);
        if (arg.out_file) {
          const path = safePath(arg.out_file as string);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, turtle, "utf8");
          return ok(`Graph written to ${path} (${turtle.length.toLocaleString('en')} characters).`);
        }
        return ok(truncate(turtle, "graph export"));
      }

      case "put_graph": {
        const hasFile = typeof arg.file === "string" && arg.file;
        const hasContent = typeof arg.content === "string" && arg.content;
        if (hasFile === hasContent) {
          throw new Error("Give exactly one of `file` or `content`.");
        }
        const content = hasFile
          ? readFileSync(safePath(arg.file as string), "utf8")
          : (arg.content as string);
        const type = (arg.content_type as string | undefined)
          || (hasFile ? mediaType(arg.file as string) : "text/turtle");
        const replace = arg.replace !== false;
        return ok(await client().writeGraph(content, arg.graph as string | undefined, replace, type));
      }

      case "delete_graph":
        return ok(await client().deleteGraph(arg.graph as string));

      case "load_file": {
        const path = safePath(arg.file as string);
        const content = readFileSync(path, "utf8");
        const replace = arg.replace === true;
        const message = await client().writeGraph(
          content, arg.graph as string | undefined, replace, mediaType(path));
        return ok(`${message}\nSource: ${path} (${content.length.toLocaleString('en')} characters).`);
      }

      case "backup": {
        const task = await client().backup(arg.dataset as string | undefined);
        return ok(`Backup started for ${ds}.\n${JSON.stringify(task, null, 2)}\n\n` +
                  `Follow it with task_status.`);
      }

      case "compact": {
        const task = await client().compact(arg.dataset as string | undefined, arg.delete_old === true);
        return ok(`Compaction started for ${ds}.\n${JSON.stringify(task, null, 2)}\n\n` +
                  `Follow it with task_status.`);
      }

      case "task_status":
        return ok(JSON.stringify(await client().taskStatus(arg.task_id as string), null, 2));
    }
  } catch (e) {
    return fail(e);
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error); 