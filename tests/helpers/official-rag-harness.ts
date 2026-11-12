import assert from 'node:assert/strict';
import ts from 'typescript';
import { contentSha256 } from '../../src/lib/baseball-qa/rag/evidence-fingerprint';
import { RAG_DOCUMENT_CANDIDATE_LIMIT, RAG_DOCUMENT_MAX_DISTANCE, type RagEvidence } from '../../src/lib/baseball-qa/rag/retrieve';

export type RpcResult = {data: unknown[] | null; error: {code: string} | null};
/** Execute the actual production function, isolated from server-only clients/secrets.
 * AST boundaries avoid fixed-width windows and comments satisfying contracts.
 */
export function loadOfficialSearch(source: string, rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>) {
  const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'searchOfficialRag');
  assert.ok(fn?.body, 'production searchOfficialRag function missing');
  const code = ts.transpileModule(fn.getText(file).replace(/^export\s+/, ''), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
  }).outputText;
  return new Function('embedQuery', 'supabaseAdmin', 'RAG_DOCUMENT_CANDIDATE_LIMIT',
    'RAG_DOCUMENT_MAX_DISTANCE', 'contentSha256', `${code}; return searchOfficialRag;`)(
    async () => ({ok: true, vector: [0.1]}), {rpc}, RAG_DOCUMENT_CANDIDATE_LIMIT,
    RAG_DOCUMENT_MAX_DISTANCE, contentSha256,
  ) as (question: string) => Promise<RagEvidence[]>;
}
