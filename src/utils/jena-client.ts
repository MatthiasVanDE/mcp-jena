import axios from 'axios';
import dotenv from 'dotenv';
import { SparqlHelper } from './sparql-helper.js';

dotenv.config();

const FUSEKI_URL = process.env.JENA_FUSEKI_URL || 'http://localhost:3030';
const DEFAULT_DATASET = process.env.DEFAULT_DATASET || 'ds';
const JENA_USERNAME = process.env.JENA_USERNAME || '';
const JENA_PASSWORD = process.env.JENA_PASSWORD || '';

// The query endpoint path UNDER the dataset. Fuseki's default configuration
// registers both /sparql and /query, but a dataset that names its own endpoints
// in a configuration file often has only 'sparql'. So 'sparql' works in both
// cases; 'query', the value this used to hold, returned 404 on such a dataset.
const JENA_QUERY_PATH = process.env.JENA_QUERY_PATH || 'sparql';
const JENA_UPDATE_PATH = process.env.JENA_UPDATE_PATH || 'update';
// The Graph Store Protocol endpoint under the dataset.
const JENA_GSP_PATH = process.env.JENA_GSP_PATH || 'data';

// Without a timeout axios waits forever. A query that stalls on a large graph
// would then hang the MCP client indefinitely, with no error and no way to
// abort.
const JENA_TIMEOUT_MS = Number(process.env.JENA_TIMEOUT_MS || 60000);

// Read-only. Set JENA_READ_ONLY=true and the writing tools are not even
// offered -- a model then cannot break anything, not even by accident. That is
// deliberately stricter than refusing on call: what is not in the tool list is
// never attempted.
export const READ_ONLY = /^(1|true|ja|yes)$/i.test(process.env.JENA_READ_ONLY || '');

// How many characters a response may occupy before it is truncated. Without
// this bound a `SELECT ?s ?p ?o` without LIMIT dumps some 600,000 characters
// into the context window -- measured on a dataset of 1599 triples.
export const MAX_RESULT_CHARS = Number(process.env.JENA_MAX_RESULT_CHARS || 100000);

// Appended to a SELECT that carries no LIMIT of its own. 0 disables it.
export const DEFAULT_LIMIT = Number(process.env.JENA_DEFAULT_LIMIT || 1000);

// The only directory files may be read from and written to. Without this
// bound, a tool that "loads a file" could send any file on this machine to a
// server.
export const FILES_DIR = process.env.JENA_FILES_DIR || '';

/**
 * Pulls the explanation out of Fuseki's response. Fuseki answers with PLAIN
 * TEXT ("Parse error: ... line 3"), not JSON. The original code read
 * `error.response.data.message`, which on a string is always undefined, so all
 * that survived was "Request failed with status code 400" -- precisely the line
 * that says nothing.
 */
function fusekiExplanation(error: any): string {
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
 * Appends a LIMIT to a SELECT that carries none of its own.
 *
 * This is the brake that was missing. A `SELECT ?s ?p ?o WHERE { ?s ?p ?o }` on
 * a modest dataset of 1599 triples yields 630,000 characters -- some 157,000
 * tokens, in a single response. A model exploring the graph asks exactly this
 * kind of query, and only notices it was too much once the context window is
 * already full.
 *
 * SELECT only, and only when no LIMIT is present: a query that brings its own
 * bound keeps it. ASK and CONSTRUCT/DESCRIBE are left alone -- a LIMIT would
 * change what they mean.
 */
export function applyLimit(query: string, limit: number): string {
  if (!limit || limit <= 0) return query;
  const bare = query
    .replace(/#[^\n]*/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  if (!/\bSELECT\b/i.test(bare)) return query;
  if (/\bLIMIT\s+\d+/i.test(bare)) return query;
  return `${query.trimEnd()}\nLIMIT ${limit}`;
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
  async executeQuery(sparqlQuery: string, limit?: number): Promise<SparqlResult> {
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

      // The brake goes on before the query leaves the building.
      sparqlQuery = applyLimit(sparqlQuery, limit ?? DEFAULT_LIMIT);

      // Add performance suggestions as warnings (but don't block execution)
      const improvements = SparqlHelper.suggestImprovements(sparqlQuery);
      if (improvements.length > 0) {
        console.warn('💡 Query suggestions:', improvements.join(', '));
      }

      // CONSTRUCT and DESCRIBE return a graph, not a binding table; with only
      // sparql-results+json in Accept, Fuseki answers 406.
      const accept = (validation.queryType === 'CONSTRUCT' || validation.queryType === 'DESCRIBE')
        ? 'text/turtle'
        : 'application/sparql-results+json';

      // POST rather than GET: building a graph takes queries far longer than
      // what fits in a URL.
      const config: any = {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: accept,
        },
        timeout: JENA_TIMEOUT_MS,
        // Reading out a graph easily yields tens of megabytes; axios truncates
        // at 10 MB by default, and would do so silently.
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
          `SPARQL query failed: ${error.message}. ${fusekiExplanation(error)}`,
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
          `SPARQL update failed: ${error.message}. ${fusekiExplanation(error)}`,
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
    // Non-empty graphs only, and that is not a shortcoming of this query: in
    // TDB2 an empty graph IS not. `CREATE GRAPH <g>` answers 200, but afterwards
    // both `GRAPH ?g { }` and the Graph Store Protocol (GET /data?graph=g ->
    // 404) report that there is nothing there. A graph comes into being with
    // its first triple. A UNION with `GRAPH ?g { }` changes none of that and on
    // a large dataset only costs time -- tried, measured.
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
  // GRAPH STORE PROTOCOL -- whole graphs, without forcing them through SPARQL
  // ======================================================================
  //
  // Fetching a 30 kB graph costs one call here. Through a CONSTRUCT the same
  // content would have to pass the query parser and then the context window;
  // REPLACING a graph is only possible in SPARQL as a DELETE followed by an
  // INSERT DATA carrying the entire content as query text.

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

  /** Fetches one named graph as Turtle. Without `graph`, the default graph. */
  async getGraph(graph?: string): Promise<string> {
    try {
      const r = await axios.get(this.gspUrl(graph),
        this.authConfig({ headers: { Accept: 'text/turtle' }, responseType: 'text' }));
      return typeof r.data === 'string' ? r.data : String(r.data);
    } catch (error) {
      throw new Error(this.gspError(error, 'reading', graph));
    }
  }

  /**
   * Writes the content of one named graph. `replace` picks between PUT (the
   * graph becomes exactly this) and POST (this is added to it).
   */
  async writeGraph(content: string, graph: string | undefined,
                   replace: boolean, contentType: string): Promise<string> {
    const method = replace ? 'put' : 'post';
    try {
      const r = await (axios as any)[method](this.gspUrl(graph), content,
        this.authConfig({ headers: { 'Content-Type': contentType } }));
      const how = replace ? 'replaced' : 'extended';
      return `Graph ${graph || '(default)'} ${how} (HTTP ${r.status}).`;
    } catch (error) {
      throw new Error(this.gspError(error, replace ? 'replacing' : 'extending', graph));
    }
  }

  /** Deletes one named graph. */
  async deleteGraph(graph: string): Promise<string> {
    try {
      const r = await axios.delete(this.gspUrl(graph), this.authConfig());
      return `Graph ${graph} deleted (HTTP ${r.status}).`;
    } catch (error) {
      throw new Error(this.gspError(error, 'deleting', graph));
    }
  }

  private gspError(error: any, what: string, graph?: string): string {
    const explanation = fusekiExplanation(error);
    const status = error?.response?.status;
    let message = `${what} graph ${graph || '(default)'} failed: ${error?.message}. ${explanation}`;
    if (status === 404) {
      message += '\n\nA 404 here means the graph is EMPTY or does not exist -- in TDB2 ' +
                 'those are the same thing. It does not mean the endpoint is missing.';
    }
    if (status === 405) {
      message += `\n\nHTTP 405: the path /${this.dataset}/${JENA_GSP_PATH} does not offer ` +
                 'this operation. Check JENA_GSP_PATH, and whether the dataset exists ' +
                 '(list_datasets).';
    }
    return message;
  }

  // ======================================================================
  // THE ADMIN LAYER -- /$/…
  // ======================================================================

  private async adminGet(path: string): Promise<any> {
    try {
      const r = await axios.get(`${this.baseUrl}/$/${path}`,
        this.authConfig({ headers: { Accept: 'application/json' } }));
      return r.data;
    } catch (error) {
      throw new Error(`Admin call /$/${path} failed: ${(error as any)?.message}. ${fusekiExplanation(error)}`);
    }
  }

  private async adminPost(path: string, params?: Record<string, string>): Promise<any> {
    try {
      const url = params ? `${this.baseUrl}/$/${path}?${new URLSearchParams(params)}`
                         : `${this.baseUrl}/$/${path}`;
      const r = await axios.post(url, '', this.authConfig());
      return r.data;
    } catch (error) {
      throw new Error(`Admin call /$/${path} failed: ${(error as any)?.message}. ${fusekiExplanation(error)}`);
    }
  }

  /** Every dataset on this server, with its endpoints. */
  async listDatasets(): Promise<any[]> {
    const data = await this.adminGet('datasets');
    return (data?.datasets || []).map((ds: any) => ({
      name: String(ds['ds.name'] || '').replace(/^\//, ''),
      active: ds['ds.state'],
      endpoints: Object.fromEntries((ds['ds.services'] || []).map(
        (s: any) => [s['srv.type'], s['srv.endpoints']])),
    }));
  }

  /** Version, uptime and the datasets at a glance. */
  async serverStatus(): Promise<any> {
    const server = await this.adminGet('server');
    let stats: any = null;
    try { stats = await this.adminGet('stats'); } catch { /* stats may be absent */ }
    return {
      version: server?.version, uptime_s: server?.uptime,
      datasets: (server?.datasets || []).map((d: any) => d['ds.name']),
      stats: stats?.datasets ?? null,
    };
  }

  /** Starts a backup of the dataset. Returns the task. */
  async backup(dataset?: string): Promise<any> {
    return this.adminPost(`backup/${dataset || this.dataset}`);
  }

  /** Starts a compaction (reclaims space from older TDB2 versions). */
  async compact(dataset?: string, deleteOld = false): Promise<any> {
    const ds = dataset || this.dataset;
    return this.adminPost(`compact/${ds}`, deleteOld ? { deleteOld: 'true' } : undefined);
  }

  /** The state of a background task (backup, compact). */
  async taskStatus(taskId: string): Promise<any> {
    return this.adminGet(`tasks/${encodeURIComponent(taskId)}`);
  }
}

export default JenaClient; 