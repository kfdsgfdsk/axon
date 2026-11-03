/**
 * Shared tronweb constructor.
 *
 * tronweb v6 ships a namespace default export; the constructor lives on
 * `.TronWeb` (the bundled types predate this shape). Fall back to the
 * default itself so a future fixed major keeps working.
 */
import TronWebPkg from 'tronweb';

export const TronWeb: any =
  (TronWebPkg as any)?.TronWeb || (TronWebPkg as any);
