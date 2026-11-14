/**
 * Webmail compose dialog: new mail, reply, forward (POST /ui/api/send).
 * Content lives in the adjacent real file compose.js (ESLint scope); this
 * module only reads it at startup. The concatenated bytes are pinned by the
 * /ui/app.js baseline test.
 */
import { readUiSibling } from '../../load-ui-asset.ts';

export const COMPOSE_PAGE_JS = readUiSibling(import.meta.url, 'compose.js');
