/**
 * Template plumbing shared by the Prisma core (`./core.ts`) and the pool
 * core (`./pool-core.ts`). Prisma-free: it reaches only PGlite and the
 * typed errors, so the `pool/testing` module graph stays pure.
 */
import { PGlite } from '@electric-sql/pglite';
import { PgBridgeError } from '../errors.ts';

/** How a template was dumped, and therefore how it must be loaded. */
export type TemplateCompression = 'none' | 'gzip';

/** The MIME type PGlite keys its gunzip decision on when loading a data
 *  directory; set from `compression` so a template that went through a
 *  file (and lost its type) loads without caller-side reconstruction. */
const TEMPLATE_MIME: Record<TemplateCompression, string> = {
  none: 'application/x-tar',
  gzip: 'application/x-gzip',
};

/**
 * Reject a `pglite` option on the template builders and loaders: a template
 * must own the instance it dumps, and a loaded context the one it loads
 * into. The types already omit the key; this catches JS callers and casts.
 */
export const rejectPglite = (
  fn: string,
  what: 'template' | 'loaded context',
  options: object | undefined,
): void => {
  if (options !== undefined && 'pglite' in options && options.pglite !== undefined) {
    throw new TypeError(
      `${fn}() does not accept a \`pglite\` option: the ${what} must own its PGlite instance`,
    );
  }
};

/**
 * Load a fresh PGlite from a template dump and wait for it to be ready.
 * A load that fails — not a data-directory tarball, dumped by another
 * PGlite version, or compressed differently than `compression` says —
 * surfaces as `TEMPLATE_LOAD_FAILED` with the PGlite error in `cause`.
 */
export const loadTemplatePglite = async (
  template: Blob | File,
  compression: TemplateCompression,
): Promise<PGlite> => {
  // Check the gzip magic against `compression` here, not in PGlite: its
  // gunzip helper leaks unhandled rejections when inflate fails, and it
  // sniffs the magic on its own, which would let a mismatch pass silently.
  const gzip = Buffer.from(await template.slice(0, 2).arrayBuffer()).toString('hex') === '1f8b';
  if (gzip !== (compression === 'gzip')) {
    throw new PgBridgeError(
      'TEMPLATE_LOAD_FAILED',
      gzip
        ? "The template is gzip-compressed but `compression` is 'none'; load it with compression: 'gzip'."
        : "`compression` is 'gzip' but the template is not gzip-compressed; load it with compression: 'none' (the default).",
    );
  }
  const loadDataDir = new Blob([template], { type: TEMPLATE_MIME[compression] });
  try {
    return await PGlite.create({ loadDataDir });
  } catch (err) {
    throw new PgBridgeError(
      'TEMPLATE_LOAD_FAILED',
      'Failed to load the PGlite template: it is not a PGlite data-directory tarball, or it was dumped by a different PGlite version.',
      { cause: err },
    );
  }
};
