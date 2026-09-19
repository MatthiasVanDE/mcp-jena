// ---------------------------------------------------------------------------
// The tool list, kept apart from the server
// ---------------------------------------------------------------------------
//
// This module holds data only: no connection, no transport, no side effect on
// import. That is deliberate -- `index.ts` calls `runServer()` at the bottom,
// so importing from there starts a stdio server. A test can load this module
// as it is.

/** The raw schemas; the annotations are attached at the bottom. */
const rawSchemas = [
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

// ---------------------------------------------------------------------------
// The annotations
// ---------------------------------------------------------------------------
//
// MCP defines four hints per tool. A host uses them to decide whether to ask
// the user for confirmation before invoking; they are advisory, so never a
// substitute for JENA_READ_ONLY or for the path check in safePath(). All four
// are declared explicitly on every tool, including where the value equals the
// default: to a host, a missing hint is not "false" but "unknown", and
// directories reject on that.
//
//   readOnlyHint     does this tool change anything?
//   destructiveHint  can something that was already there be lost?
//   idempotentHint   does calling it twice leave the same state?
//   openWorldHint    does it talk to something outside this server?
//
// Two calls that are not self-evident:
//
// * `execute_sparql_query` and `get_graph` are called read-only here, while
//   with `out_file` they do write a file. That write is optional, goes only to
//   JENA_FILES_DIR, and never touches the dataset. Marking them false would end
//   every SELECT in a confirmation prompt -- that costs more than it is worth.
//   Anyone weighing it differently can set these two to false; the tests here
//   still hold.
// * `load_file` and `put_graph` are called destructive because `replace: true`
//   empties the target graph first. The default for load_file is to append, but
//   a hint describes what a tool CAN do, not what it usually does.

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const annotations: Record<string, ToolAnnotations> = {
  // Reading from the dataset.
  execute_sparql_query:   { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  list_graphs:            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  get_graph:              { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  list_datasets:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  server_status:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  task_status:            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },

  // No server, no network: the templates live in this code. The only tool with
  // openWorldHint false.
  sparql_query_templates: { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },

  // Writing. An arbitrary UPDATE may be a DELETE or a DROP, and running it
  // twice does not leave the same state (an INSERT with blank nodes, a DELETE
  // that finds nothing the second time) -- hence idempotent false.
  execute_sparql_update:  { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },

  // Graph Store Protocol PUT and DELETE are idempotent by definition: repeating
  // the same call leaves the graph in the same state.
  put_graph:              { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true  },
  delete_graph:           { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true  },

  // Appending (POST) is not idempotent: blank nodes get fresh labels on every
  // load, so loading the same file twice duplicates whatever hangs off them.
  load_file:              { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },

  // Both write on the server (a backup file, a new TDB2 generation) without any
  // data disappearing, and both start a fresh task with a fresh task id on
  // every call.
  backup:                 { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
  compact:                { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
};

/**
 * The tool list as ListTools offers it, annotations included.
 *
 * If one is missing, the server falls over on startup rather than quietly
 * offering a tool without hints -- a new tool without annotations is a bug, not
 * a detail.
 */
export const toolSchemas = rawSchemas.map(t => {
  const a = annotations[t.name];
  if (!a) throw new Error(`Tool ${t.name} has no annotations in tools.ts`);
  return { ...t, annotations: a };
});

/**
 * Which tools change the DATASET. In read-only mode they are not offered at
 * all; not offering is stricter than refusing on call, because a model does not
 * attempt what is not in the list.
 *
 * This is not the same as `readOnlyHint === false`: `backup` and `compact` do
 * write on the server, but change no triple, and so stay usable in read-only
 * mode. The tests guard one direction of that relation -- everything listed
 * here must have readOnlyHint false.
 */
export const WRITING_TOOLS = new Set([
  "execute_sparql_update", "put_graph", "delete_graph", "load_file", "compact",
]);
