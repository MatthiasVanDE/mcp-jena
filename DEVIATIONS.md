# Deviations from upstream

This clone of [ramuzes/mcp-jena](https://github.com/ramuzes/mcp-jena) sits on
upstream commit `a8bd18c` with five commits of its own on top. Upstream as it
stands on GitHub does not start and cannot create a graph; what follows is what
changed and why. All of it was verified against a running Apache Jena Fuseki
6.2.0 with a TDB2 dataset.

## It did not start

1. **`anthropic@^0.17.0` in `package.json` does not exist on npm.** `npm
   install` failed outright because of it -- not a single dependency came in.
   Nothing in `src/` imported the package. Removed, along with `cors` and
   `node-fetch`, which were not imported either.

2. **`tsc` refused to build.** The `vendor` and `schemas` fields in the server
   metadata do not exist on `Implementation` in the current MCP SDK. The tools
   are offered through the ListTools handler regardless.

3. **Three `console.log` lines wrote to stdout.** stdout carries the JSON-RPC
   channel of MCP; any line on it corrupts the protocol. Now `console.error`.

## It addressed the wrong endpoint

4. **Queries went to `/<dataset>/query`.** A dataset that names its own
   endpoints in a Fuseki configuration often has only `sparql`, and so answered
   404 to every query. Now configurable through `JENA_QUERY_PATH`, defaulting to
   `sparql` -- which exists on Fuseki's default configuration too.

5. **GET with the query in the URL.** Building a graph takes queries far longer
   than what fits in a URL. Now POST, form-encoded.

6. **`Accept` was fixed at `application/sparql-results+json`.** CONSTRUCT and
   DESCRIBE return a graph, not a binding table, and got 406. The Accept header
   now follows the query form.

## The validator rejected valid SPARQL

7. **`CREATE GRAPH <g>` was rejected as "no query form"** -- the very command
   you install this server for. CREATE, DROP, CLEAR, LOAD, COPY, MOVE, ADD and
   WITH are now in the list of permitted forms.

8. **The `WHERE` keyword was made mandatory.** In SPARQL it is optional:
   `SELECT ?s { ?s ?p ?o }` is valid and was rejected before the query ever
   reached Fuseki. The same held for FILTER outside a block containing the word
   WHERE.

9. **The query form was determined with `includes()` in a fixed order.** That
   made `CONSTRUCT { ... } WHERE { { SELECT ... } }` a SELECT, with the wrong
   response format as a result. Now the first keyword decides the form, after
   comments, string literals and IRIs have been stripped from the query -- a
   prefix such as `<http://example.org/select>` is not a query form.

10. **The advice "PREFIX declarations should end with a dot (.)" was wrong.**
    That is Turtle; in SPARQL a dot after a PREFIX line is a syntax error. The
    advice appeared in two places and has been inverted: a dot after PREFIX now
    produces an error.

## Errors were unreadable

11. **Fuseki's own explanation was lost.** The code read
    `error.response.data.message`, but Fuseki answers with plain text. On a
    string, `.message` is always `undefined`, so all that survived was "Request
    failed with status code 400". Now "Parse error: Line 1, column 16:
    Unresolved prefixed name: ex:unknown" simply comes along.

12. **405 was never explained.** It is precisely the error for a wrong endpoint
    path *and* for a dataset that does not exist -- in that second case Fuseki
    answers 405, not 404.

## Other

13. **No timeout on the HTTP calls.** A stalled query left the MCP client
    waiting forever. Now `JENA_TIMEOUT_MS`, 60 s by default. `maxContentLength`
    was lifted as well: axios silently truncated responses above 10 MB, and
    reading out a graph easily exceeds that.

14. **CONSTRUCT results were made unreadable.** Turtle through `JSON.stringify`
    yields a line full of `\n` escapes. Strings now go to the client unchanged.

15. **Dead code removed.** `src/utils/auth.ts` and
    `src/utils/sparql-query-tool.ts` were imported by nothing; `auth.ts` did pull
    in express, and with it two vulnerabilities in `qs`. `npm audit` now reports
    zero.

## What was NOT repaired, because it is not a fault

`list_graphs` shows only graphs holding at least one triple. That is not a
shortcoming of the query: in TDB2 an empty graph **is** not. `CREATE GRAPH <g>`
answers 200, but afterwards both `GRAPH ?g { }` and the Graph Store Protocol
(`GET /data?graph=g` -> 404) report that there is nothing there. A graph comes
into being with its first triple. A UNION with `GRAPH ?g { }` was tried, changes
nothing and only costs time; it was reverted. Instead the behaviour is stated in
the tool descriptions, so that the model using them does not believe it created
a graph that is not there. Use `INSERT DATA { GRAPH <g> { ... } }`: that creates
the graph and fills it in one go.

---

# Extensions (third commit)

Upstream offers four tools. They cover SPARQL, but nothing around it: no admin
layer, no Graph Store Protocol, and no bound whatsoever on what comes back.
Thirteen now.

| New | Why |
|---|---|
| `list_datasets` | Fuseki answers **405, not 404**, for a dataset that does not exist. Without this, that error is indistinguishable from a wrong endpoint path. |
| `server_status` | version, uptime, per-dataset statistics |
| `get_graph` | a 30 kB graph in one call, bypassing the query parser |
| `put_graph` | replacing a graph with a PUT — how a schema layer ought to be synchronised |
| `delete_graph` | throwing a graph away, with a pointer to `backup` beside it |
| `load_file` | RDF off disk; a 44 kB ontology as `INSERT DATA` costs ~11,000 tokens |
| `backup` | there is no undo after `DROP GRAPH` |
| `compact` | reclaiming TDB2 space |
| `task_status` | backup and compact run in the background |

And three things that are not tools:

16. **There was no brake on responses.** `limit`, `offset`, `cursor`, `maxRows`
    and `truncate` occurred zero times in the source. A `SELECT ?s ?p ?o` without
    LIMIT on 1599 triples gave 630,000 characters — ~157,000 tokens in a single
    response. Now: `JENA_DEFAULT_LIMIT` behind a SELECT without a LIMIT of its
    own, `JENA_MAX_RESULT_CHARS` as a hard cut-off, and `out_file` to disk.

17. **No read-only mode.** `JENA_READ_ONLY=true` leaves the five writing tools
    out of the list, and refuses them as the **first** step in the handler. That
    order is no detail: with the check further down, the existing if-chain
    caught `execute_sparql_update` first and the request went out anyway. Which
    is exactly what happened on the first attempt.

18. **File access without a bound is not file access but a leak.** Everything
    that reads or writes stays inside `JENA_FILES_DIR`; without that setting it
    is off. Climbing out with `../` is refused.

Alongside those, `JENA_CONTEXT_FILE`: a JSON file with prefixes and the meaning
of the named graphs, appended to the description of the SPARQL tools. It lets
the model know which graphs exist and what belongs in them while this server
stays generic — that knowledge is configuration, not source code.

# Annotations and tests (fourth commit)

External feedback on this server named two things, and both held: not one tool
carried annotations, and there was no test that named even a single tool.

19. **All thirteen tools now carry all four MCP hints** (`readOnlyHint`,
    `destructiveHint`, `idempotentHint`, `openWorldHint`), explicitly as
    booleans — including where the value equals the default. To a host, a
    missing hint is not "false" but "unknown", and directories reject on that.
    They sit as a table in `src/tools.ts`, with the reasoning per line. The
    server falls over on startup if a tool has no annotations, so a new tool
    cannot get past without them.

    Two calls that are not self-evident are explained there as well:
    `execute_sparql_query` and `get_graph` are called read-only although with
    `out_file` they write a file (optional, only inside `JENA_FILES_DIR`, and the
    dataset is untouched — marking them false would turn every SELECT into a
    confirmation prompt), and `load_file` is called destructive although it
    appends by default, because `replace: true` empties the target graph and a
    hint describes what a tool *can* do.

20. **The tool list now lives in `src/tools.ts`, apart from the server.**
    `index.ts` calls `runServer()` at the bottom, so importing from there starts
    a stdio server — which left the list untestable. The new module holds data
    only and has no side effect on import.

21. **`npm test` runs 71 tests, and every tool appears by name.** Two files, no
    new dependencies (`node --test`, and Node strips the types itself):

    * `test/tool-contract.test.ts` — the contract per tool: four boolean hints,
      nothing that calls itself read-only and destructive at once, an input
      schema in which every required field is also described, and the agreement
      that everything in `WRITING_TOOLS` carries `readOnlyHint: false`.
    * `test/tool-calls.test.ts` — every tool called once for real over stdio,
      against a stand-in Fuseki (`test/helpers/stub-fuseki.ts`), asserting the
      path each request landed on. That is the test that would have caught the
      two bugs above: a query to `/query` instead of `/sparql`, and a
      `console.log` corrupting the JSON-RPC channel. The `JENA_FILES_DIR`
      boundary is exercised from both sides.

    The tests run against `dist/`, so `npm test` builds first. They sit outside
    `tsconfig.json` on purpose: were `include` to take them in, the output
    directory would shift to `dist/src/index.js` and the launcher path would
    break.

# Language (fifth commit)

Comments, error messages, test names and this document were written in Dutch
while this clone was a private tool. They are English throughout since the
repository became public; identifiers were renamed along with them
(`SCHRIJVENDE_TOOLS` → `WRITING_TOOLS`, `veiligPad` → `safePath`). One change
reaches outside the source: the `JENA_CONTEXT_FILE` JSON now reads `meaning` and
`writtenBy` where it used to read `betekenis` and `schrijver`.
