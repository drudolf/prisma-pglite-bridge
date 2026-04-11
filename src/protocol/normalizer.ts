/**
 * Wire protocol normalizer for PGlite.
 *
 * PGlite runs PostgreSQL in single-user mode, which sends ReadyForQuery (Z)
 * after every message — including mid-sequence Extended Query Protocol messages.
 * Standard PostgreSQL only sends ReadyForQuery after Sync (S) or SimpleQuery (Q).
 *
 * tokio-postgres (used by Prisma's Schema Engine) is strict about this and
 * rejects the duplicate ReadyForQuery as UnexpectedMessage.
 *
 * This normalizer strips ReadyForQuery from responses to messages that shouldn't
 * produce it: Parse (P), Bind (B), Describe (D), Execute (E), Close (C), Flush (H).
 * Only Sync (S) and SimpleQuery (Q) responses retain ReadyForQuery.
 */

// Message type bytes
const READY_FOR_QUERY = 0x5a; // 'Z'
const PARSE = 0x50; // 'P'
const BIND = 0x42; // 'B'
const DESCRIBE = 0x44; // 'D'
const EXECUTE = 0x45; // 'E'
const CLOSE = 0x43; // 'C'
const FLUSH = 0x48; // 'H'

// Extended Query Protocol message types that should NOT produce ReadyForQuery
const EXTENDED_QUERY_MESSAGES = new Set([PARSE, BIND, DESCRIBE, EXECUTE, CLOSE, FLUSH]);

/**
 * Strips trailing ReadyForQuery messages from a PGlite response buffer
 * when the originating client message was an Extended Query Protocol message.
 *
 * ReadyForQuery is always exactly 6 bytes: Z + 4-byte length (5) + status byte
 */
const stripTrailingReadyForQuery = (response: Uint8Array): Uint8Array => {
  if (response.length < 6) return response;

  const lastMsgStart = response.length - 6;
  if (
    response[lastMsgStart] === READY_FOR_QUERY &&
    response[lastMsgStart + 1] === 0x00 &&
    response[lastMsgStart + 2] === 0x00 &&
    response[lastMsgStart + 3] === 0x00 &&
    response[lastMsgStart + 4] === 0x05
  ) {
    return response.slice(0, lastMsgStart);
  }

  return response;
};

/**
 * Determines if the client message type should produce a ReadyForQuery response.
 * Only Sync and SimpleQuery should. All Extended Query Protocol messages should not.
 */
const shouldHaveReadyForQuery = (messageType: number): boolean =>
  !EXTENDED_QUERY_MESSAGES.has(messageType);

/**
 * Returns the message type byte from a client wire protocol message.
 *
 * Startup messages (no type byte) start with a 4-byte length followed by
 * the protocol version (196608 = 0x00030000). These always get ReadyForQuery.
 */
const getMessageType = (message: Uint8Array): number | null => {
  if (message.length < 1) return null;

  const firstByte = message[0] ?? 0x00;

  // Startup message: starts with length (4 bytes) + protocol version (4 bytes)
  // First byte will be 0x00 (length MSB) — not a valid message type
  if (firstByte === 0x00) return null;

  return firstByte;
};

/**
 * Creates a normalizer function that processes PGlite wire protocol responses.
 *
 * ```typescript
 * const normalize = createProtocolNormalizer();
 * const response = await pglite.execProtocolRawStream(message, ...);
 * const normalized = normalize(message, response);
 * ```
 */
export const createProtocolNormalizer = () => {
  return (clientMessage: Uint8Array, pgliteResponse: Uint8Array): Uint8Array => {
    const messageType = getMessageType(clientMessage);

    // Startup messages, Sync, SimpleQuery, Terminate — pass through unchanged
    if (messageType === null || shouldHaveReadyForQuery(messageType)) {
      return pgliteResponse;
    }

    // Extended Query Protocol messages — strip ReadyForQuery
    return stripTrailingReadyForQuery(pgliteResponse);
  };
};

export {
  stripTrailingReadyForQuery,
  shouldHaveReadyForQuery,
  getMessageType,
  EXTENDED_QUERY_MESSAGES,
};
