export interface ValidationResult {
  valid: boolean;
  errors: string[];
  suggestions: string[];
  queryType?: 'SELECT' | 'CONSTRUCT' | 'ASK' | 'DESCRIBE' | 'INSERT' | 'DELETE' | 'UPDATE' | 'UNKNOWN';
}

export class SparqlHelper {
  /**
   * Validates a SPARQL query and provides suggestions
   */
  static validateQuery(query: string): ValidationResult {
    const errors: string[] = [];
    const suggestions: string[] = [];
    
    if (!query.trim()) {
      errors.push("Query cannot be empty");
      return { valid: false, errors, suggestions };
    }
    
    const upperQuery = query.toUpperCase();
    const trimmedQuery = query.trim();
    
    // The FIRST keyword decides the form, not "does it occur anywhere".
    // With includes() in a fixed order,
    //   CONSTRUCT { ?s ?p ?o } WHERE { { SELECT ... } }
    // became a SELECT, whereupon the client asks for the wrong response format
    // and Fuseki answers 406. Comments, literals and IRIs are stripped first: a
    // prefix such as <http://example.org/select> is not a query form.
    const queryType = SparqlHelper.detectQueryType(query);
    
    // Check for query form
    // The graph management operations are listed explicitly. Without them this
    // validator rejected a bare `CREATE GRAPH <...>` or `LOAD <...> INTO GRAPH
    // <...>` as "no query form" -- precisely the statements that bring a graph
    // into being.
    const hasQueryForm = [
      'SELECT', 'CONSTRUCT', 'ASK', 'DESCRIBE', 'INSERT', 'DELETE',
      'CREATE', 'DROP', 'CLEAR', 'LOAD', 'COPY', 'MOVE', 'ADD', 'WITH',
    ].some(form => upperQuery.includes(form));
    
    if (!hasQueryForm) {
      errors.push("Query must include a query form: SELECT, CONSTRUCT, ASK, DESCRIBE, INSERT, or DELETE");
      suggestions.push("Example: SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10");
      return { valid: false, errors, suggestions, queryType };
    }
    
    // NOT an error: the WHERE keyword is optional in SPARQL.
    // `SELECT ?s { ?s ?p ?o }` is valid and was rejected here before the query
    // ever reached Fuseki. Only a missing group graph pattern is a real
    // problem, and that is for Fuseki's parser to report.
    if ((queryType === 'SELECT' || queryType === 'CONSTRUCT') && !query.includes('{')) {
      suggestions.push("A SELECT or CONSTRUCT normally needs a group graph pattern: { ?s ?p ?o }");
    }
    
    // Check for balanced braces
    const openBraces = (query.match(/{/g) || []).length;
    const closeBraces = (query.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      errors.push(`Unbalanced braces: ${openBraces} opening braces, ${closeBraces} closing braces`);
      suggestions.push("Check that every { has a matching }");
    }
    
    // Check for balanced parentheses
    const openParens = (query.match(/\(/g) || []).length;
    const closeParens = (query.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      errors.push(`Unbalanced parentheses: ${openParens} opening, ${closeParens} closing`);
      suggestions.push("Check that every ( has a matching )");
    }
    
    // This used to advise that PREFIX lines must end in a dot. That is Turtle,
    // not SPARQL: in SPARQL, `PREFIX ex: <http://example.org/> .` is itself a
    // syntax error. Following that advice broke the query.
    const dottedPrefixes = query.split('\n').filter(line =>
      line.trim().toUpperCase().startsWith('PREFIX') && line.trim().endsWith('.')
    );
    if (dottedPrefixes.length > 0) {
      errors.push("PREFIX declarations must NOT end with a dot in SPARQL (that is Turtle syntax)");
    }
    
    // Suggest LIMIT for potentially large result sets
    if (queryType === 'SELECT' && !upperQuery.includes('LIMIT') && !upperQuery.includes('COUNT')) {
      suggestions.push("Consider adding LIMIT clause to prevent large result sets");
    }
    
    // Check for common syntax issues
    if (query.includes('?') && !query.includes('WHERE')) {
      suggestions.push("Variables (starting with ?) typically appear in WHERE clauses");
    }
    
    // Check for property path syntax issues
    if (query.includes('/') || query.includes('*') || query.includes('+')) {
      if (!upperQuery.includes('WHERE')) {
        suggestions.push("Property paths (/, *, +) should be used within WHERE clauses");
      }
    }
    
    // Likewise: FILTER belongs inside a group graph pattern, and that pattern
    // does not need the word WHERE. `SELECT ?s { ?s ?p ?o FILTER(isIRI(?s)) }`
    // is valid; this used to be a hard block on valid SPARQL.
    if (upperQuery.includes('FILTER') && !query.includes('{')) {
      errors.push("FILTER must appear inside a group graph pattern { }");
    }
    
    return { 
      valid: errors.length === 0, 
      errors, 
      suggestions, 
      queryType 
    };
  }
  
  /**
   * Determines the query form from the first keyword that really is a keyword:
   * comments, string literals and IRIs do not count.
   */
  static detectQueryType(query: string): ValidationResult['queryType'] {
    const bare = query
      .replace(/#[^\n]*/g, ' ')
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ')
      .replace(/<[^>]*>/g, ' ');

    const m = bare.match(
      /\b(SELECT|CONSTRUCT|ASK|DESCRIBE|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b/i);
    if (!m) return 'UNKNOWN';

    const word = m[1].toUpperCase();
    if (word === 'SELECT' || word === 'CONSTRUCT' || word === 'ASK' || word === 'DESCRIBE') {
      return word;
    }
    if (word === 'INSERT' || word === 'DELETE') return word;
    // LOAD/CLEAR/CREATE/DROP/COPY/MOVE/ADD/WITH are graph-level updates.
    return 'UPDATE';
  }

  /**
   * Provides enhanced error messages with SPARQL-specific guidance
   */
  static enhanceErrorMessage(originalError: string, query: string): string {
    let enhancedMessage = originalError;
    
    const upperQuery = query.toUpperCase();
    
    // Common error patterns and their solutions
    if (originalError.includes('400') || originalError.includes('Bad Request')) {
      enhancedMessage += "\n\n🔧 Common SPARQL syntax issues:";
      enhancedMessage += "\n• PREFIX lines take no trailing dot (that is Turtle, not SPARQL)";
      enhancedMessage += "\n• Ensure proper triple pattern syntax: ?subject ?predicate ?object";
      enhancedMessage += "\n• Verify WHERE clause is properly formed with { }";
      enhancedMessage += "\n• Check for missing closing braces }";
      enhancedMessage += "\n• Validate property path syntax (/, *, +, ?, ^)";
      
      if (upperQuery.includes('FILTER')) {
        enhancedMessage += "\n• FILTER clauses must be inside WHERE blocks";
      }
    }
    
    if (originalError.includes('401') || originalError.includes('Unauthorized')) {
      enhancedMessage += "\n\n🔐 Authentication issue: Check your username and password";
    }
    
    if (originalError.includes('404') || originalError.includes('Not Found')) {
      enhancedMessage += "\n\n🎯 Endpoint issue: Verify the dataset name and Fuseki URL";
      enhancedMessage += "\n• List the datasets that actually exist: GET <fuseki-url>/$/datasets";
    }

    // 405 is what you get when the PATH exists but the operation is not
    // offered on it -- sending an update to a query endpoint, say, or a
    // JENA_QUERY_PATH that does not match the dataset configuration.
    if (originalError.includes('405') || originalError.includes('Method Not Allowed')) {
      enhancedMessage += "\n\n🚧 Wrong endpoint path for this operation, OR the dataset does not exist.";
      enhancedMessage += "\n• Fuseki answers 405 (not 404) when the dataset name is unknown";
      enhancedMessage += "\n• A query goes to /<dataset>/sparql, an update to /<dataset>/update";
      enhancedMessage += "\n• Check JENA_QUERY_PATH / JENA_UPDATE_PATH against GET <fuseki-url>/$/datasets";
    }
    
    if (originalError.includes('timeout')) {
      enhancedMessage += "\n\n⏱️ Query timeout: Try adding LIMIT clause or simplifying the query";
    }
    
    return enhancedMessage;
  }
  
  /**
   * Suggests query improvements based on content analysis
   */
  static suggestImprovements(query: string): string[] {
    const suggestions: string[] = [];
    const upperQuery = query.toUpperCase();
    
    // Performance suggestions
    if (upperQuery.includes('SELECT') && !upperQuery.includes('LIMIT') && !upperQuery.includes('COUNT')) {
      suggestions.push("Add LIMIT clause for better performance and testing");
    }
    
    if (upperQuery.includes('?S ?P ?O') && !upperQuery.includes('LIMIT')) {
      suggestions.push("Querying all triples (?s ?p ?o) without LIMIT can be very slow");
    }
    
    // Readability suggestions
    if (!query.includes('\n') && query.length > 100) {
      suggestions.push("Consider formatting the query with line breaks for better readability");
    }
    
    if (upperQuery.includes('FILTER') && upperQuery.includes('REGEX')) {
      suggestions.push("REGEX filters can be slow; consider using more specific triple patterns when possible");
    }
    
    // Best practices
    if (upperQuery.includes('OPTIONAL') && !upperQuery.includes('BOUND')) {
      suggestions.push("Consider using BOUND() function to check if OPTIONAL variables are bound");
    }
    
    return suggestions;
  }
  
  /**
   * Generates example queries for learning
   */
  static generateExampleQueries(): { [category: string]: string[] } {
    return {
      basic: [
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10",
        "SELECT (COUNT(*) as ?count) WHERE { ?s ?p ?o }",
        "SELECT DISTINCT ?type WHERE { ?s a ?type }"
      ],
      propertyPaths: [
        "SELECT ?person ?friend WHERE { ?person foaf:knows/foaf:knows ?friend }",
        "SELECT ?person ?connected WHERE { ?person foaf:knows* ?connected }",
        "SELECT ?child ?parent WHERE { ?child ^ex:hasParent ?parent }"
      ],
      filters: [
        "SELECT ?person ?age WHERE { ?person ex:age ?age . FILTER(?age > 18) }",
        "SELECT ?person WHERE { ?person foaf:name ?name . FILTER(REGEX(?name, \"John\", \"i\")) }"
      ],
      optional: [
        "SELECT ?person ?name ?email WHERE { ?person a foaf:Person . OPTIONAL { ?person foaf:name ?name } OPTIONAL { ?person foaf:mbox ?email } }"
      ],
      aggregation: [
        "SELECT ?type (COUNT(?instance) as ?count) WHERE { ?instance a ?type } GROUP BY ?type ORDER BY DESC(?count)"
      ]
    };
  }
  
  /**
   * Common vocabulary prefixes for convenience
   */
  static getCommonPrefixes(): Record<string, string> {
    return {
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      owl: "http://www.w3.org/2002/07/owl#",
      foaf: "http://xmlns.com/foaf/0.1/",
      dcterms: "http://purl.org/dc/terms/",
      skos: "http://www.w3.org/2004/02/skos/core#",
      schema: "http://schema.org/",
      xsd: "http://www.w3.org/2001/XMLSchema#",
      geo: "http://www.w3.org/2003/01/geo/wgs84_pos#",
      time: "http://www.w3.org/2006/time#"
    };
  }
} 