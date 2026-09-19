// ---------------------------------------------------------------------------
// De gereedschapslijst, apart van de server
// ---------------------------------------------------------------------------
//
// Deze module bevat alleen gegevens: geen verbinding, geen transport, geen
// bijwerking bij importeren. Dat is met opzet -- `index.ts` roept onderaan
// `runServer()` aan, dus wie daaruit importeert start een stdio-server. Een
// test kan deze module wel gewoon inladen.

/** De ruwe schema's; de annotaties komen er onderaan bij. */
const ruweSchemas = [
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
// De annotaties
// ---------------------------------------------------------------------------
//
// MCP kent vier hints per gereedschap. Een host gebruikt ze om te beslissen of
// hij de gebruiker om bevestiging vraagt voordat hij aanroept; ze zijn
// adviserend, dus nooit een vervanging voor JENA_READ_ONLY of voor de
// padcontrole in veiligPad(). Alle vier staan hier expliciet op elk
// gereedschap, ook waar de waarde de standaard is: een ontbrekende hint is
// voor een host niet "false" maar "onbekend", en registers weigeren erop.
//
//   readOnlyHint     verandert dit gereedschap iets?
//   destructiveHint  kan er iets verloren gaan dat er al was?
//   idempotentHint   levert twee keer hetzelfde aanroepen dezelfde toestand op?
//   openWorldHint    praat het met iets buiten deze server?
//
// Twee afwegingen die niet vanzelf spreken:
//
// * `execute_sparql_query` en `get_graph` heten hier read-only, terwijl ze met
//   `out_file` wél een bestand schrijven. Dat schrijven is optioneel, gaat
//   uitsluitend naar JENA_FILES_DIR en raakt de dataset niet. Ze op false
//   zetten zou elke SELECT in een bevestigingsvraag laten eindigen -- dat kost
//   meer dan het waard is. Wie dat anders weegt, zet deze twee op false; de
//   tests hier blijven kloppen.
// * `load_file` en `put_graph` heten destructief omdat `replace: true` de
//   doelgraaf eerst leegmaakt. De standaard van load_file is aanvullen, maar
//   een hint beschrijft wat een gereedschap KAN, niet wat het meestal doet.

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const annotaties: Record<string, ToolAnnotations> = {
  // Lezen uit de dataset.
  execute_sparql_query:   { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  list_graphs:            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  get_graph:              { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  list_datasets:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  server_status:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  task_status:            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },

  // Geen server, geen netwerk: de sjablonen staan in deze code. Het enige
  // gereedschap met openWorldHint false.
  sparql_query_templates: { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },

  // Schrijven. Een willekeurige UPDATE kan DELETE of DROP zijn en twee keer
  // uitvoeren geeft niet dezelfde toestand (INSERT met bnodes, DELETE dat de
  // tweede keer niets meer vindt) -- vandaar idempotent false.
  execute_sparql_update:  { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },

  // PUT en DELETE van het Graph Store Protocol zijn per definitie idempotent:
  // dezelfde aanroep herhalen laat de graaf in dezelfde toestand achter.
  put_graph:              { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true  },
  delete_graph:           { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true  },

  // Aanvullen (POST) is niet idempotent: blanke knopen krijgen bij elke
  // inlading nieuwe labels, dus hetzelfde bestand twee keer laden verdubbelt
  // wat eraan hangt.
  load_file:              { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },

  // Beide schrijven op de server (een backupbestand, een nieuwe TDB2-generatie)
  // zonder dat er data verdwijnt, en beide starten elke keer een nieuwe taak
  // met een nieuw taaknummer.
  backup:                 { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
  compact:                { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
};

/**
 * De gereedschapslijst zoals ListTools hem aanbiedt, annotaties inbegrepen.
 *
 * Ontbreekt er een, dan valt de server meteen bij het starten om in plaats van
 * stilzwijgend een gereedschap zonder hints aan te bieden -- een nieuw
 * gereedschap zonder annotaties is een fout, geen detail.
 */
export const toolSchemas = ruweSchemas.map(t => {
  const a = annotaties[t.name];
  if (!a) throw new Error(`Gereedschap ${t.name} heeft geen annotaties in tools.ts`);
  return { ...t, annotations: a };
});

/**
 * Welke gereedschappen de DATASET veranderen. In read-only modus worden ze niet
 * aangeboden; niet aanbieden is strenger dan weigeren bij aanroep, want wat
 * niet in de lijst staat probeert een model niet.
 *
 * Dit is niet hetzelfde als `readOnlyHint === false`: `backup` en `compact`
 * schrijven wel op de server, maar veranderen geen triple, en blijven daarom
 * ook read-only bruikbaar. De tests bewaken één kant van die verhouding --
 * alles wat hier staat, moet readOnlyHint false hebben.
 */
export const SCHRIJVENDE_TOOLS = new Set([
  "execute_sparql_update", "put_graph", "delete_graph", "load_file", "compact",
]);
