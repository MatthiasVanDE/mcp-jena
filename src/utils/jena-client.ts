import axios from 'axios';
import dotenv from 'dotenv';
import { SparqlHelper } from './sparql-helper.js';

dotenv.config();

const FUSEKI_URL = process.env.JENA_FUSEKI_URL || 'http://localhost:3030';
const DEFAULT_DATASET = process.env.DEFAULT_DATASET || 'ds';
const JENA_USERNAME = process.env.JENA_USERNAME || '';
const JENA_PASSWORD = process.env.JENA_PASSWORD || '';

// Het pad van het query-endpoint ONDER de dataset. Fuseki's standaardconfig
// registreert zowel /sparql als /query, maar een dataset die in een
// config-bestand haar endpoints zelf benoemt heeft vaak alleen 'sparql'
// (zo ook deploy/fuseki/echo.ttl in dit project). 'sparql' werkt dus in
// beide gevallen; 'query', de oude waarde hier, gaf 404 op zo'n dataset.
const JENA_QUERY_PATH = process.env.JENA_QUERY_PATH || 'sparql';
const JENA_UPDATE_PATH = process.env.JENA_UPDATE_PATH || 'update';
// Het Graph Store Protocol-endpoint onder de dataset.
const JENA_GSP_PATH = process.env.JENA_GSP_PATH || 'data';

// Zonder timeout wacht axios oneindig. Een query die op een grote graaf
// vastloopt zou de MCP-client dan voorgoed laten hangen, zonder foutmelding
// en zonder manier om af te breken.
const JENA_TIMEOUT_MS = Number(process.env.JENA_TIMEOUT_MS || 60000);

// Alleen lezen. Zet JENA_READ_ONLY=true en de schrijvende gereedschappen worden
// niet eens aangeboden -- een model kan dan niets kapotmaken, ook niet per
// ongeluk. Dat is bewust harder dan "weigeren bij aanroep": wat niet in de
// gereedschapslijst staat, wordt niet geprobeerd.
export const READ_ONLY = /^(1|true|ja|yes)$/i.test(process.env.JENA_READ_ONLY || '');

// Hoeveel tekens een antwoord hoogstens mag beslaan voordat het wordt afgekapt.
// Zonder deze grens stort een `SELECT ?s ?p ?o` zonder LIMIT zo 600 000 tekens
// in het contextvenster -- gemeten op een dataset van 1599 triples.
export const MAX_RESULT_CHARS = Number(process.env.JENA_MAX_RESULT_CHARS || 100000);

// Wordt aan een SELECT zonder eigen LIMIT toegevoegd. 0 schakelt het uit.
export const DEFAULT_LIMIT = Number(process.env.JENA_DEFAULT_LIMIT || 1000);

// De enige map waaruit bestanden gelezen en waarheen ze geschreven mogen
// worden. Zonder deze grens zou een gereedschap dat "een bestand laadt" elk
// bestand op deze machine naar een server kunnen sturen.
export const FILES_DIR = process.env.JENA_FILES_DIR || '';

/**
 * Haalt de uitleg uit het antwoord van Fuseki. Fuseki antwoordt met PLATTE
 * TEKST ("Parse error: ... line 3"), niet met JSON. De oude code las
 * `error.response.data.message` en dat is op een string altijd undefined, dus
 * bleef er alleen "Request failed with status code 400" over -- precies de
 * regel die niets zegt.
 */
function fusekiUitleg(error: any): string {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 2000);
  if (data && typeof data === 'object') {
    return (data.message || JSON.stringify(data)).slice(0, 2000);
  }
  return '';
}

/**
 * Represents the result of a SPARQL query
 */
export interface SparqlResult {
  head: {
    vars: string[];
  };
  results: {
    bindings: Array<{
      [key: string]: {
        type: string;
        value: string;
        datatype?: string;
        "xml:lang"?: string;
      };
    }>;
  };
}

/**
 * Plakt een LIMIT achter een SELECT die er zelf geen heeft.
 *
 * Dit is de rem die ontbrak. Een `SELECT ?s ?p ?o WHERE { ?s ?p ?o }` op een
 * bescheiden dataset van 1599 triples levert 630 000 tekens op -- zo'n 157 000
 * tokens, in één antwoord. Een model dat de graaf verkent vraagt precies zulke
 * queries, en merkt pas dat het te veel was als het contextvenster al vol is.
 *
 * Alleen bij SELECT, en alleen als er geen eigen LIMIT staat: een query die
 * zijn eigen grens meebrengt, houdt die. ASK en CONSTRUCT/DESCRIBE blijven
 * ongemoeid -- daar zou een LIMIT de betekenis veranderen.
 */
export function pasLimietToe(query: string, limiet: number): string {
  if (!limiet || limiet <= 0) return query;
  const kaal = query
    .replace(/#[^\n]*/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  if (!/\bSELECT\b/i.test(kaal)) return query;
  if (/\bLIMIT\s+\d+/i.test(kaal)) return query;
  return `${query.trimEnd()}\nLIMIT ${limiet}`;
}

/**
 * Client for interacting with Apache Jena Fuseki SPARQL endpoint
 */
export class JenaClient {
  private baseUrl: string;
  private dataset: string;
  private username: string;
  private password: string;

  /**
   * Creates a new Jena client
   * @param baseUrl - Jena Fuseki server URL. Defaults to environment variable or 'http://localhost:3030'
   * @param dataset - Dataset name. Defaults to environment variable or 'ds'
   * @param username - Username for HTTP Basic authentication. Defaults to environment variable
   * @param password - Password for HTTP Basic authentication. Defaults to environment variable
   */
  constructor(
    baseUrl = FUSEKI_URL, 
    dataset = DEFAULT_DATASET, 
    username = JENA_USERNAME, 
    password = JENA_PASSWORD
  ) {
    this.baseUrl = baseUrl;
    this.dataset = dataset;
    this.username = username;
    this.password = password;
  }

  /**
   * Executes a SPARQL query against the Jena dataset
   * @param sparqlQuery - The SPARQL query to execute
   * @returns Query results
   */
  async executeQuery(sparqlQuery: string, limiet?: number): Promise<SparqlResult> {
    try {
      // Validate query before execution
      const validation = SparqlHelper.validateQuery(sparqlQuery);
      if (!validation.valid) {
        const errorMsg = `Invalid SPARQL query:\n${validation.errors.join('\n')}`;
        const suggestions = validation.suggestions.length > 0 
          ? `\n\nSuggestions:\n${validation.suggestions.join('\n')}` 
          : '';
        throw new Error(errorMsg + suggestions);
      }

      // De rem erop vóór de query de deur uit gaat.
      sparqlQuery = pasLimietToe(sparqlQuery, limiet ?? DEFAULT_LIMIT);

      // Add performance suggestions as warnings (but don't block execution)
      const improvements = SparqlHelper.suggestImprovements(sparqlQuery);
      if (improvements.length > 0) {
        console.warn('💡 Query suggestions:', improvements.join(', '));
      }

      // CONSTRUCT en DESCRIBE geven een graaf terug, geen bindingstabel;
      // met alleen sparql-results+json in Accept antwoordt Fuseki met 406.
      const accept = (validation.queryType === 'CONSTRUCT' || validation.queryType === 'DESCRIBE')
        ? 'text/turtle'
        : 'application/sparql-results+json';

      // POST en niet GET: een graaf opbouwen gaat met queries die ruim langer
      // zijn dan wat er in een URL past.
      const config: any = {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: accept,
        },
        timeout: JENA_TIMEOUT_MS,
        // Een graaf uitlezen levert zo een antwoord van tientallen megabytes;
        // axios kapt standaard af op 10 MB en zou dat stil doen.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      };

      // Add authentication if credentials are provided
      if (this.username && this.password) {
        config.auth = {
          username: this.username,
          password: this.password
        };
      }

      const response = await axios.post(`${this.baseUrl}/${this.dataset}/${JENA_QUERY_PATH}`,
        new URLSearchParams({ query: sparqlQuery }), config);

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const enhancedError = SparqlHelper.enhanceErrorMessage(
          `SPARQL query failed: ${error.message}. ${fusekiUitleg(error)}`,
          sparqlQuery
        );
        throw new Error(enhancedError);
      }
      throw error;
    }
  }

  /**
   * Executes a SPARQL update query against the Jena dataset
   * @param sparqlUpdate - The SPARQL update query to execute
   * @returns Success message
   */
  async executeUpdate(sparqlUpdate: string): Promise<string> {
    try {
      // Basic validation for update queries
      const validation = SparqlHelper.validateQuery(sparqlUpdate);
      if (!validation.valid) {
        const errorMsg = `Invalid SPARQL update:\n${validation.errors.join('\n')}`;
        const suggestions = validation.suggestions.length > 0 
          ? `\n\nSuggestions:\n${validation.suggestions.join('\n')}` 
          : '';
        throw new Error(errorMsg + suggestions);
      }

      const config: any = {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: JENA_TIMEOUT_MS,
        maxBodyLength: Infinity,
      };

      // Add authentication if credentials are provided
      if (this.username && this.password) {
        config.auth = {
          username: this.username,
          password: this.password
        };
      }

      await axios.post(
        `${this.baseUrl}/${this.dataset}/${JENA_UPDATE_PATH}`,
        new URLSearchParams({ update: sparqlUpdate }),
        config
      );

      return 'Update successful';
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const enhancedError = SparqlHelper.enhanceErrorMessage(
          `SPARQL update failed: ${error.message}. ${fusekiUitleg(error)}`,
          sparqlUpdate
        );
        throw new Error(enhancedError);
      }
      throw error;
    }
  }

  /**
   * Lists all available graphs in the dataset
   * @returns Array of graph URIs
   */
  async listGraphs(): Promise<string[]> {
    // Alleen niet-lege grafen, en dat is geen tekortkoming van deze query:
    // in TDB2 IS een lege graaf niet. `CREATE GRAPH <g>` antwoordt met 200,
    // maar daarna geeft zowel `GRAPH ?g { }` als het Graph Store Protocol
    // (GET /data?graph=g -> 404) aan dat er niets is. De graaf ontstaat pas
    // bij de eerste triple. Een UNION met `GRAPH ?g { }` verandert daar niets
    // aan en kost op een grote dataset alleen tijd -- geprobeerd, gemeten.
    const query = `
      SELECT DISTINCT ?g
      WHERE {
        GRAPH ?g { ?s ?p ?o }
      }
    `;

    const result = await this.executeQuery(query);
    return result.results.bindings.map(binding => binding.g.value);
  }

  // ======================================================================
  // GRAPH STORE PROTOCOL -- hele grafen, zonder ze door SPARQL te wringen
  // ======================================================================
  //
  // Een graaf van 30 kB ophalen kost hier één aanroep. Via een CONSTRUCT zou
  // dezelfde inhoud door de queryparser en daarna door het contextvenster
  // moeten; een graaf VERVANGEN kan met SPARQL alleen als DELETE gevolgd door
  // een INSERT DATA met de volledige inhoud als queryteskt.

  private gspUrl(graph?: string): string {
    const basis = `${this.baseUrl}/${this.dataset}/${JENA_GSP_PATH}`;
    return graph ? `${basis}?${new URLSearchParams({ graph }).toString()}`
                 : `${basis}?default`;
  }

  private authConfig(extra: any = {}): any {
    const config: any = {
      timeout: JENA_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      ...extra,
    };
    if (this.username && this.password) {
      config.auth = { username: this.username, password: this.password };
    }
    return config;
  }

  /** Haalt één named graph op als Turtle. Zonder `graph` de default graph. */
  async getGraph(graph?: string): Promise<string> {
    try {
      const r = await axios.get(this.gspUrl(graph),
        this.authConfig({ headers: { Accept: 'text/turtle' }, responseType: 'text' }));
      return typeof r.data === 'string' ? r.data : String(r.data);
    } catch (error) {
      throw new Error(this.gspFout(error, 'lezen', graph));
    }
  }

  /**
   * Zet de inhoud van één named graph. `vervang` kiest tussen PUT (de graaf
   * wordt precies dit) en POST (dit komt erbij).
   */
  async writeGraph(inhoud: string, graph: string | undefined,
                   vervang: boolean, contentType: string): Promise<string> {
    const methode = vervang ? 'put' : 'post';
    try {
      const r = await (axios as any)[methode](this.gspUrl(graph), inhoud,
        this.authConfig({ headers: { 'Content-Type': contentType } }));
      const hoe = vervang ? 'vervangen' : 'aangevuld';
      return `Graaf ${graph || '(default)'} ${hoe} (HTTP ${r.status}).`;
    } catch (error) {
      throw new Error(this.gspFout(error, vervang ? 'vervangen' : 'aanvullen', graph));
    }
  }

  /** Verwijdert één named graph. */
  async deleteGraph(graph: string): Promise<string> {
    try {
      const r = await axios.delete(this.gspUrl(graph), this.authConfig());
      return `Graaf ${graph} verwijderd (HTTP ${r.status}).`;
    } catch (error) {
      throw new Error(this.gspFout(error, 'verwijderen', graph));
    }
  }

  private gspFout(error: any, wat: string, graph?: string): string {
    const uitleg = fusekiUitleg(error);
    const status = error?.response?.status;
    let bericht = `Graaf ${wat} mislukt voor ${graph || '(default)'}: ${error?.message}. ${uitleg}`;
    if (status === 404) {
      bericht += '\n\nEen 404 betekent hier dat de graaf LEEG is of niet bestaat -- ' +
                 'in TDB2 is dat hetzelfde. Het betekent niet dat het endpoint ontbreekt.';
    }
    if (status === 405) {
      bericht += `\n\nHTTP 405: het pad /${this.dataset}/${JENA_GSP_PATH} biedt deze ` +
                 'operatie niet aan. Controleer JENA_GSP_PATH en of de dataset bestaat ' +
                 '(list_datasets).';
    }
    return bericht;
  }

  // ======================================================================
  // DE ADMINLAAG -- /$/…
  // ======================================================================

  private async adminGet(pad: string): Promise<any> {
    try {
      const r = await axios.get(`${this.baseUrl}/$/${pad}`,
        this.authConfig({ headers: { Accept: 'application/json' } }));
      return r.data;
    } catch (error) {
      throw new Error(`Adminaanroep /$/${pad} mislukt: ${(error as any)?.message}. ${fusekiUitleg(error)}`);
    }
  }

  private async adminPost(pad: string, params?: Record<string, string>): Promise<any> {
    try {
      const url = params ? `${this.baseUrl}/$/${pad}?${new URLSearchParams(params)}`
                         : `${this.baseUrl}/$/${pad}`;
      const r = await axios.post(url, '', this.authConfig());
      return r.data;
    } catch (error) {
      throw new Error(`Adminaanroep /$/${pad} mislukt: ${(error as any)?.message}. ${fusekiUitleg(error)}`);
    }
  }

  /** Alle datasets op deze server, met hun endpoints. */
  async listDatasets(): Promise<any[]> {
    const data = await this.adminGet('datasets');
    return (data?.datasets || []).map((ds: any) => ({
      naam: String(ds['ds.name'] || '').replace(/^\//, ''),
      actief: ds['ds.state'],
      endpoints: Object.fromEntries((ds['ds.services'] || []).map(
        (s: any) => [s['srv.type'], s['srv.endpoints']])),
    }));
  }

  /** Versie, uptime en de datasets in één blik. */
  async serverStatus(): Promise<any> {
    const server = await this.adminGet('server');
    let stats: any = null;
    try { stats = await this.adminGet('stats'); } catch { /* stats mag ontbreken */ }
    return {
      versie: server?.version, uptime_s: server?.uptime,
      datasets: (server?.datasets || []).map((d: any) => d['ds.name']),
      stats: stats?.datasets ?? null,
    };
  }

  /** Start een backup van de dataset. Geeft de taak terug. */
  async backup(dataset?: string): Promise<any> {
    return this.adminPost(`backup/${dataset || this.dataset}`);
  }

  /** Start een compactie (ruimt oude TDB2-versies op). */
  async compact(dataset?: string, deleteOld = false): Promise<any> {
    const ds = dataset || this.dataset;
    return this.adminPost(`compact/${ds}`, deleteOld ? { deleteOld: 'true' } : undefined);
  }

  /** De toestand van een achtergrondtaak (backup, compact). */
  async taskStatus(taskId: string): Promise<any> {
    return this.adminGet(`tasks/${encodeURIComponent(taskId)}`);
  }
}

export default JenaClient; 