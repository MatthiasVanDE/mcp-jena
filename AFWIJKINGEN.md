# Afwijkingen ten opzichte van upstream

Deze kloon van [ramuzes/mcp-jena](https://github.com/ramuzes/mcp-jena) staat
op upstream-commit `a8bd18c` met twee eigen commits erbovenop. Upstream zoals
het op GitHub staat start niet en kan geen graaf aanleggen; hieronder staat wat
er is veranderd en waarom. Alles is geverifieerd tegen een draaiende Apache
Jena Fuseki 6.2.0 met een TDB2-dataset.

## Het startte niet

1. **`anthropic@^0.17.0` in `package.json` bestaat niet op npm.** `npm install`
   faalde daardoor volledig -- er kwam geen enkele dependency binnen. Niets in
   `src/` importeerde het pakket. Verwijderd, net als `cors` en `node-fetch`,
   die evenmin geimporteerd werden.

2. **`tsc` weigerde te bouwen.** De velden `vendor` en `schemas` in de
   Server-metadata bestaan niet in `Implementation` van de huidige MCP-SDK. De
   tools worden hoe dan ook via de ListTools-handler aangeboden.

3. **Drie `console.log`-regels schreven naar stdout.** Over stdout loopt het
   JSON-RPC-kanaal van MCP; elke regel ervoor bederft het protocol. Nu
   `console.error`.

## Het sprak het verkeerde endpoint aan

4. **Queries gingen naar `/<dataset>/query`.** Een dataset die haar endpoints
   zelf benoemt in een Fuseki-configuratie heeft vaak alleen `sparql`, en gaf
   dus 404 op elke query. Nu instelbaar via `JENA_QUERY_PATH`, standaard
   `sparql` -- dat bestaat ook op Fuseki's standaardconfiguratie.

5. **GET met de query in de URL.** Een graaf opbouwen gaat met queries die
   ruim langer zijn dan wat in een URL past. Nu POST, form-encoded.

6. **`Accept` stond vast op `application/sparql-results+json`.** CONSTRUCT en
   DESCRIBE geven een graaf terug, geen bindingstabel, en kregen 406. De
   Accept-header volgt nu de queryvorm.

## De validator weigerde geldige SPARQL

7. **`CREATE GRAPH <g>` werd geweigerd als "geen queryvorm"** -- juist het
   commando waarvoor je deze server binnenhaalt. CREATE, DROP, CLEAR, LOAD,
   COPY, MOVE, ADD en WITH staan nu in de lijst met toegestane vormen.

8. **Het sleutelwoord `WHERE` werd verplicht gesteld.** In SPARQL is het
   optioneel: `SELECT ?s { ?s ?p ?o }` is geldig en werd geweigerd voordat de
   query Fuseki bereikte. Idem voor FILTER buiten een blok met het woord WHERE.

9. **De queryvorm werd bepaald met `includes()` in vaste volgorde.** Daardoor
   was `CONSTRUCT { ... } WHERE { { SELECT ... } }` een SELECT, met het
   verkeerde antwoordformaat als gevolg. Nu bepaalt het eerste sleutelwoord de
   vorm, nadat commentaar, tekstliteralen en IRI's uit de query zijn gehaald --
   een prefix als `<http://example.org/select>` is geen queryvorm.

10. **Het advies "PREFIX declarations should end with a dot (.)" was onjuist.**
    Dat is Turtle; in SPARQL is een punt achter een PREFIX-regel een
    syntaxfout. Het advies stond op twee plaatsen en is omgekeerd: een punt
    achter PREFIX levert nu een foutmelding op.

## Fouten waren niet te lezen

11. **Fuseki's eigen uitleg ging verloren.** De code las
    `error.response.data.message`, maar Fuseki antwoordt met platte tekst. Op
    een string is `.message` altijd `undefined`, dus bleef er alleen "Request
    failed with status code 400" over. Nu komt "Parse error: Line 1, column 16:
    Unresolved prefixed name: ex:onbekend" gewoon mee.

12. **405 werd nergens verklaard.** Dat is precies de fout bij een verkeerd
    endpointpad *en* bij een dataset die niet bestaat -- Fuseki antwoordt in
    dat tweede geval met 405, niet met 404.

## Overig

13. **Geen timeout op de HTTP-aanroepen.** Een vastgelopen query liet de
    MCP-client oneindig wachten. Nu `JENA_TIMEOUT_MS`, standaard 60 s. Ook
    `maxContentLength` opgeheven: axios kapte antwoorden boven 10 MB stil af,
    en een graaf uitlezen gaat daar makkelijk overheen.

14. **CONSTRUCT-resultaten werden onleesbaar gemaakt.** Turtle door
    `JSON.stringify` levert een regel vol `\n`-ontsnappingen op. Strings gaan
    nu ongewijzigd naar de client.

15. **Dode code verwijderd.** `src/utils/auth.ts` en
    `src/utils/sparql-query-tool.ts` werden door niets geimporteerd; `auth.ts`
    trok wel express binnen, en daarmee twee kwetsbaarheden in `qs`.
    `npm audit` meldt nu nul.

## Wat NIET gerepareerd is, omdat het geen fout is

`list_graphs` toont alleen grafen met minstens één triple. Dat is geen
tekortkoming van de query: in TDB2 **is** een lege graaf niet. `CREATE GRAPH
<g>` antwoordt met 200, maar daarna geeft zowel `GRAPH ?g { }` als het Graph
Store Protocol (`GET /data?graph=g` -> 404) aan dat er niets is. De graaf
ontstaat pas bij de eerste triple. Een UNION met `GRAPH ?g { }` is geprobeerd,
verandert niets en kost alleen tijd; die is teruggedraaid. In plaats daarvan
staat het gedrag nu in de beschrijving van de tools, zodat het model dat ze
gebruikt niet denkt een graaf te hebben aangelegd die er niet is. Gebruik
`INSERT DATA { GRAPH <g> { ... } }`: dat maakt de graaf en vult hem in één keer.
