# MCP Server for Apache Jena

> **This clone deviates from upstream.** See [DEVIATIONS.md](DEVIATIONS.md):
> upstream does not install, does not build, addresses the wrong endpoint, and
> rejects the very statements that create a graph. Everything below holds, with
> those repairs on top.

A Model Context Protocol (MCP) server that connects AI agents to Apache Jena for SPARQL query capabilities.

## Overview

This project implements an MCP server that allows AI agents (such as Cursor, Claude for Cline, or Claude Desktop) to access and query RDF data stored in Apache Jena. The server provides tools for executing SPARQL queries and updates against a Jena Fuseki server.

## Features

- Execute SPARQL queries and updates against a Jena Fuseki server
- Read, replace and delete whole named graphs over the Graph Store Protocol
- Load RDF files from disk without their content passing through the context
- Admin operations: list datasets, server status, backup, compact, task status
- Bounded responses: a default LIMIT, a hard character cut-off, output to file
- A read-only mode, and file access confined to one directory
- HTTP Basic authentication support for Jena Fuseki
- Compatible with the Model Context Protocol

## Prerequisites

- Node.js (v16 or later)
- Apache Jena Fuseki server running with your RDF data loaded
- An AI agent that supports the Model Context Protocol (e.g., Cursor, Claude for Cline)

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/ramuzes/mcp-jena.git
   cd mcp-jena
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build the TypeScript code:
   ```
   npm run build
   ```

## Usage

Run the server with default settings (localhost:3030 for Jena, 'ds' for dataset):

```
npm start
```

Or specify custom Jena endpoint, dataset, and authentication credentials:

```
npm start -- --endpoint http://your-jena-server:3030 --dataset your_dataset --username your_username --password your_password
```

You can also use short flags:

```
npm start -- -e http://your-jena-server:3030 -d your_dataset -u your_username -p your_password
```

For development mode with automatic transpilation:

```
npm run dev:transpile -- -e http://your-jena-server:3030 -d your_dataset -u your_username -p your_password
```

## Docker

You can run the MCP Jena server using Docker:

### Building the Docker image

```bash
docker build -t mcp-jena .
```

### Running with Docker

```bash
docker run -e JENA_FUSEKI_URL=http://your-jena-server:3030 -e DEFAULT_DATASET=your_dataset mcp-jena
```

## Available Tools

This MCP server provides the following tools:

1. **`execute_sparql_query`** - Execute a SPARQL query against the Jena dataset
   - Includes comprehensive SPARQL syntax documentation
   - Property path operators (/, *, +, ?, ^, |) with examples
   - Common query patterns and templates
   - Automatic query validation and suggestions

2. **`execute_sparql_update`** - Execute a SPARQL update query to modify the dataset  
   - Insert/Delete operations documentation
   - Conditional updates with WHERE clauses
   - Graph management operations

3. **`list_graphs`** - List all available named graphs in the dataset
   - Graph usage patterns and best practices
   - Provenance and versioning examples

4. **`sparql_query_templates`** - Get pre-built SPARQL query templates
   - **exploration**: Basic data discovery and statistics
   - **property-paths**: Complex graph navigation patterns  
   - **statistics**: Knowledge graph metrics and analysis
   - **validation**: Data quality and consistency checks
   - **schema**: Structure discovery and documentation


### Tool annotations

All thirteen tools, with the four MCP annotations each of them carries. Every
hint is declared explicitly as a boolean, including where the value equals the
default: a missing hint means "unknown" to a host, not "false".

| Tool | read-only | destructive | idempotent | open world | What it does |
| --- | --- | --- | --- | --- | --- |
| `execute_sparql_query` | yes | no | yes | yes | Execute a SPARQL query against an Apache Jena dataset |
| `execute_sparql_update` | no | yes | no | yes | Execute a SPARQL update query against an Apache Jena dataset |
| `list_graphs` | yes | no | yes | yes | List all available named graphs in an Apache Jena dataset |
| `sparql_query_templates` | yes | no | yes | no | Get SPARQL query templates for common knowledge graph exploration patterns |
| `list_datasets` | yes | no | yes | yes | List the datasets on this Fuseki server, with their endpoints |
| `server_status` | yes | no | yes | yes | Version, uptime and per-dataset statistics of the Fuseki server |
| `get_graph` | yes | no | yes | yes | Fetch one named graph in full, as Turtle, via the Graph Store Protocol |
| `put_graph` | no | yes | yes | yes | Replace (PUT) or extend (POST) one named graph with RDF content |
| `delete_graph` | no | yes | yes | yes | Delete one named graph and everything in it. Irreversible |
| `load_file` | no | yes | no | yes | Load an RDF file from disk into a dataset, without it passing through the context |
| `backup` | no | no | no | yes | Start a server-side backup of a dataset. Returns the task id |
| `compact` | no | no | no | yes | Compact a TDB2 dataset: reclaim space left by earlier versions of the data |
| `task_status` | yes | no | yes | yes | The state of a background task started by backup or compact |

Two of these deserve a word. `execute_sparql_query` and `get_graph` are marked
read-only even though `out_file` makes them write a file: that write is
optional, confined to `JENA_FILES_DIR`, and never touches the dataset. Marking
them otherwise would turn every SELECT into a confirmation prompt. `load_file`
is marked destructive even though it appends by default, because `replace: true`
empties the target graph first — a hint describes what a tool *can* do.

The hints are advisory. They are not a substitute for `JENA_READ_ONLY`, which is
what actually keeps the writing tools out of reach.

## Testing

```bash
npm test
```

Builds, then runs 71 tests with `node --test` — no test framework, no extra
dependencies. `test/gereedschappen.test.ts` checks the contract of every tool by
name (its four hints, its input schema). `test/aanroepen.test.ts` starts the
built server over stdio against a stub Fuseki and calls each of the thirteen
tools once, asserting which endpoint the request actually reached.

Requires Node 22.6 or newer: the tests are TypeScript and rely on Node stripping
the types itself. They sit outside `tsconfig.json` on purpose — including them
would move the build output to `dist/src/index.js` and break the launcher path.

## Environment Variables

You can also configure the server using environment variables:

- `JENA_FUSEKI_URL`: URL of your Jena Fuseki server (default: http://localhost:3030)
- `DEFAULT_DATASET`: Default dataset name (default: ds)
- `JENA_USERNAME`: Username for HTTP Basic authentication to Jena Fuseki
- `JENA_PASSWORD`: Password for HTTP Basic authentication to Jena Fuseki
- `JENA_QUERY_PATH`: Query endpoint path under the dataset (default: `sparql`).
  Fuseki's default config registers both `sparql` and `query`, but a dataset
  that names its own endpoints in a config file often has only `sparql`.
- `JENA_UPDATE_PATH`: Update endpoint path under the dataset (default: `update`)
- `JENA_TIMEOUT_MS`: HTTP timeout in milliseconds (default: `60000`)
- `PORT`: Port for the MCP server (for HTTP transport, default: 8080)
- `API_KEY`: API key for MCP server authentication

## Example SPARQL Queries

### Basic SELECT query:

```sparql
SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object
}
LIMIT 10
```

### Insert data with UPDATE:

```sparql
PREFIX ex: <http://example.org/>
INSERT DATA {
  ex:subject1 ex:predicate1 "object1" .
  ex:subject2 ex:predicate2 42 .
}
```

### Query a specific named graph:

```sparql
SELECT ?subject ?predicate ?object
FROM NAMED <http://example.org/graph1>
WHERE {
  GRAPH <http://example.org/graph1> {
    ?subject ?predicate ?object
  }
}
LIMIT 10
```

## Resources

- [Apache Jena](https://jena.apache.org/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [SPARQL Query Language](https://www.w3.org/TR/sparql11-query/) 