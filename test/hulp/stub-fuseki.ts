// Een nagemaakte Fuseki: genoeg ervan om elk gereedschap één keer echt over
// HTTP te laten lopen, zonder dat er een Jena-server hoeft te draaien.
//
// Hij onthoudt elk verzoek dat binnenkomt, zodat een test kan nakijken WAT er
// verstuurd is -- het endpointpad, de methode, de body. Precies daar zaten de
// fouten die deze kloon van upstream moest repareren (queries gingen naar
// /query in plaats van /sparql), dus daar hoort de assertie op te staan.

import { createServer, type IncomingMessage, type Server } from "node:http";

export interface Verzoek {
  methode: string;
  pad: string;
  query: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface StubFuseki {
  url: string;
  verzoeken: Verzoek[];
  laatste(): Verzoek;
  stop(): Promise<void>;
}

const RESULTAAT_JSON = JSON.stringify({
  head: { vars: ["s", "p", "o"] },
  results: { bindings: [{
    s: { type: "uri", value: "http://example.org/a" },
    p: { type: "uri", value: "http://example.org/b" },
    o: { type: "literal", value: "c" },
  }] },
});

const GRAFEN_JSON = JSON.stringify({
  head: { vars: ["g"] },
  results: { bindings: [{ g: { type: "uri", value: "http://example.org/graaf" } }] },
});

const TURTLE = '<http://example.org/a> <http://example.org/b> "c" .\n';

async function lees(req: IncomingMessage): Promise<string> {
  const stukken: Buffer[] = [];
  for await (const s of req) stukken.push(s as Buffer);
  return Buffer.concat(stukken).toString("utf8");
}

export async function startStub(): Promise<StubFuseki> {
  const verzoeken: Verzoek[] = [];

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://stub");
    const body = await lees(req);
    verzoeken.push({
      methode: req.method || "",
      pad: u.pathname,
      query: u.search,
      body,
      headers: req.headers as any,
    });

    const antwoord = (status: number, type: string, tekst: string) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(tekst);
    };

    // --- SPARQL ---------------------------------------------------------
    if (u.pathname.endsWith("/sparql")) {
      // De body is application/x-www-form-urlencoded, dus de query staat er
      // gecodeerd in; er rechtstreeks op matchen levert stil het verkeerde
      // antwoord op.
      const query = new URLSearchParams(body).get("query") || "";
      // list_graphs vraagt naar ?g; een gewone query krijgt de ?s ?p ?o-tabel.
      const isGrafenvraag = /SELECT\s+DISTINCT\s+\?g/i.test(query);
      return antwoord(200, "application/sparql-results+json",
        isGrafenvraag ? GRAFEN_JSON : RESULTAAT_JSON);
    }
    if (u.pathname.endsWith("/update")) return antwoord(200, "text/plain", "");

    // --- Graph Store Protocol -------------------------------------------
    if (u.pathname.endsWith("/data")) {
      if (req.method === "GET") return antwoord(200, "text/turtle", TURTLE);
      if (req.method === "DELETE") return antwoord(204, "text/plain", "");
      return antwoord(200, "text/plain", "");           // PUT en POST
    }

    // --- De adminlaag ----------------------------------------------------
    if (u.pathname === "/$/datasets") {
      return antwoord(200, "application/json", JSON.stringify({ datasets: [
        { "ds.name": "/ds", "ds.state": true, "ds.services": [
          { "srv.type": "gsp-rw", "srv.endpoints": ["data"] },
        ] },
      ] }));
    }
    if (u.pathname === "/$/server") {
      return antwoord(200, "application/json", JSON.stringify({
        version: "5.6.0", uptime: 42, datasets: [{ "ds.name": "/ds" }],
      }));
    }
    if (u.pathname === "/$/stats") {
      return antwoord(200, "application/json", JSON.stringify({ datasets: {} }));
    }
    if (u.pathname.startsWith("/$/backup/") || u.pathname.startsWith("/$/compact/")) {
      return antwoord(200, "application/json", JSON.stringify({ taskId: "7", requestId: 7 }));
    }
    if (u.pathname.startsWith("/$/tasks/")) {
      return antwoord(200, "application/json", JSON.stringify({
        taskId: u.pathname.split("/").pop(), started: "2026-09-19T08:00:00Z", finished: null,
      }));
    }

    antwoord(404, "text/plain", "geen zulk pad in de stub");
  });

  await new Promise<void>(klaar => server.listen(0, "127.0.0.1", klaar));
  const poort = (server.address() as any).port;

  return {
    url: `http://127.0.0.1:${poort}`,
    verzoeken,
    laatste: () => verzoeken[verzoeken.length - 1],
    stop: () => new Promise<void>(klaar => server.close(() => klaar())),
  };
}
