/** JS equivalent of PostgreSQL's `quote_ident()`; matches its escaping rules. */
export const quoteIdent = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
