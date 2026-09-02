/**
 * Repo-subset scope primitive (P2A productionization, Task 3).
 *
 * A "repo" is the first path segment of a node's `file_path` — our working DBs
 * lay repos out under `<repo>/`, so `file_path.split('/')[0]` IS the repo. This
 * module gives the query layer an OPTIONAL, additive way to restrict a query
 * over a merged multi-repo DB to a chosen set of repos, so it never returns or
 * expands into an out-of-scope repo. When no repo-set is supplied the caller
 * applies no predicate and behavior is byte-identical to upstream.
 *
 * Standalone (no imports) so both `db/queries` and `graph/traversal` can import
 * it without a cycle; `resolution/index` re-exports `repoOfFilePath` from here
 * to keep a single definition.
 */

/**
 * The repo an endpoint belongs to: the `file_path` first segment. Returns
 * `undefined` for an empty path or a root-level file with no `<repo>/` prefix.
 */
export function repoOfFilePath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const seg = filePath.split('/')[0];
  return seg || undefined;
}

/**
 * Escape the SQL `LIKE` metacharacters (`\`, `%`, `_`) so a repo name is matched
 * literally under `ESCAPE '\'`. Repo names come from file paths — untrusted — so
 * a name containing `%`/`_` must not become a wildcard.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A repo-scope SQL predicate + its bound params, or `null` when `repos` is
 * empty/absent (the caller then applies no scope — the upstream default).
 *
 * For each repo the predicate admits a node whose `file_path` is either exactly
 * `<repo>` (a bare root file named for the repo) or under `<repo>/…`. Built with
 * `?` placeholders ONLY — repo strings are never interpolated into SQL.
 *
 * @param repos  the in-scope repo names
 * @param column the file-path column to test (default `file_path`); pass a
 *               table-qualified name like `n.file_path` when the query joins.
 */
export function buildRepoScopeClause(
  repos: readonly string[] | undefined,
  column = 'file_path',
): { sql: string; params: string[] } | null {
  if (!repos || repos.length === 0) return null;
  const clauses: string[] = [];
  const params: string[] = [];
  for (const repo of repos) {
    clauses.push(`(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`);
    params.push(repo, `${escapeLike(repo)}/%`);
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * In-memory membership test mirroring {@link buildRepoScopeClause}, for
 * JS-side filtering (search post-gate, traversal neighbor admission).
 */
export function repoInScope(
  filePath: string | undefined,
  repoSet: ReadonlySet<string>,
): boolean {
  const repo = repoOfFilePath(filePath);
  return repo !== undefined && repoSet.has(repo);
}
