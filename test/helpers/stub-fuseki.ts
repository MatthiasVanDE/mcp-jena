// A stand-in Fuseki: just enough of one to let every tool make a real HTTP
// round trip, without a Jena server having to run.
//
// It records every request that comes in, so a test can check WHAT was sent --
// the endpoint path, the method, the body. That is exactly where the bugs sat
// that this clone had to repair (queries went to /query instead of /sparql), so
// that is where the assertion belongs.

import { createServer, type IncomingMessage, type Server } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface StubFuseki {
  url: string;
  requests: RecordedRequest[];
  last(): RecordedRequest;
  stop(): Promise<void>;
}

const RESULT_JSON = JSON.stringify({
  head: { vars: ["s", "p", "o"] },
  results: { bindings: [{
    s: { type: "uri", value: "http://example.org/a" },
    p: { type: "uri", value: "http://example.org/b" },
    o: { type: "literal", value: "c" },
  }] },
});

const GRAPHS_JSON = JSON.stringify({
  head: { vars: ["g"] },
  results: { bindings: [{ g: { type: "uri", value: "http://example.org/graph" } }] },
});

const TURTLE = '<http://example.org/a> <http://example.org/b> "c" .\n';

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startStub(): Promise<StubFuseki> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://stub");
    const body = await read(req);
    requests.push({
      method: req.method || "",
      path: u.pathname,
      query: u.search,
      body,
      headers: req.headers as any,
    });

    const respond = (status: number, type: string, text: string) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(text);
    };

    // --- SPARQL ---------------------------------------------------------
    if (u.pathname.endsWith("/sparql")) {
      // The body is application/x-www-form-urlencoded, so the query sits in it
      // encoded; matching on it directly quietly returns the wrong answer.
      const query = new URLSearchParams(body).get("query") || "";
      // list_graphs asks for ?g; any other query gets the ?s ?p ?o table.
      const isGraphQuestion = /SELECT\s+DISTINCT\s+\?g/i.test(query);
      return respond(200, "application/sparql-results+json",
        isGraphQuestion ? GRAPHS_JSON : RESULT_JSON);
    }
    if (u.pathname.endsWith("/update")) return respond(200, "text/plain", "");

    // --- Graph Store Protocol -------------------------------------------
    if (u.pathname.endsWith("/data")) {
      if (req.method === "GET") return respond(200, "text/turtle", TURTLE);
      if (req.method === "DELETE") return respond(204, "text/plain", "");
      return respond(200, "text/plain", "");            // PUT and POST
    }

    // --- The admin layer -------------------------------------------------
    if (u.pathname === "/$/datasets") {
      return respond(200, "application/json", JSON.stringify({ datasets: [
        { "ds.name": "/ds", "ds.state": true, "ds.services": [
          { "srv.type": "gsp-rw", "srv.endpoints": ["data"] },
        ] },
      ] }));
    }
    if (u.pathname === "/$/server") {
      return respond(200, "application/json", JSON.stringify({
        version: "5.6.0", uptime: 42, datasets: [{ "ds.name": "/ds" }],
      }));
    }
    if (u.pathname === "/$/stats") {
      return respond(200, "application/json", JSON.stringify({ datasets: {} }));
    }
    if (u.pathname.startsWith("/$/backup/") || u.pathname.startsWith("/$/compact/")) {
      return respond(200, "application/json", JSON.stringify({ taskId: "7", requestId: 7 }));
    }
    if (u.pathname.startsWith("/$/tasks/")) {
      return respond(200, "application/json", JSON.stringify({
        taskId: u.pathname.split("/").pop(), started: "2026-09-19T08:00:00Z", finished: null,
      }));
    }

    respond(404, "text/plain", "no such path in the stub");
  });

  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as any).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    last: () => requests[requests.length - 1],
    stop: () => new Promise<void>(done => server.close(() => done())),
  };
}
