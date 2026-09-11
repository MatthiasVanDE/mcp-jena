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

// Zonder timeout wacht axios oneindig. Een query die op een grote graaf
// vastloopt zou de MCP-client dan voorgoed laten hangen, zonder foutmelding
// en zonder manier om af te breken.
const JENA_TIMEOUT_MS = Number(process.env.JENA_TIMEOUT_MS || 60000);

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
  async executeQuery(sparqlQuery: string): Promise<SparqlResult> {
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
}

export default JenaClient; 