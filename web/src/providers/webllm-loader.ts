/** Opt-in loader for the optional peer dependency `@mlc-ai/web-llm`.
 *
 * Import this entry only if you use the `webllm` provider; applications that do not
 * never resolve (or download) the library:
 *
 *     import { webllm } from '@corbet-labs/ccht/providers';
 *     import { loadWebLlm } from '@corbet-labs/ccht/providers/webllm-loader';
 *     const local = webllm({ load: loadWebLlm });
 *
 * The import is dynamic, so the library is fetched only when `prepare()` runs
 * after an explicit user action.
 */
import type { WebLlmModule } from './webllm.ts';

export const loadWebLlm = (): Promise<WebLlmModule> => import('@mlc-ai/web-llm') as unknown as Promise<WebLlmModule>;
