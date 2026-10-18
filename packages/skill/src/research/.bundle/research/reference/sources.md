# Search sources

All endpoints below work without an API key. On a 429 or 5xx, back off once, then continue
without that source. Never ask the user to install or configure anything during a run.

## Web search

- With the `websearch` tool: use it, then `webfetch` the results you cite.
- Without `websearch`: `webfetch https://html.duckduckgo.com/html/?q=<url-encoded query>`.
  Result links look like `//duckduckgo.com/l/?uddg=<encoded URL>`; decode `uddg` before fetching.
  Operators: `site:github.com`, `"exact phrase"`; add `&df=y` (past year) or `&df=m` (past month).

## Papers

- arXiv: `http://export.arxiv.org/api/query?search_query=all:<terms>&sortBy=submittedDate&max_results=10`
- Semantic Scholar: `https://api.semanticscholar.org/graph/v1/paper/search?query=<q>&fields=title,year,abstract,citationCount,url&limit=10` (about 1 request per second)
- OpenAlex: `https://api.openalex.org/works?search=<q>&per-page=10`
- Full text: `https://arxiv.org/abs/<id>` or `https://ar5iv.org/abs/<id>`

## Code

- GitHub search: `https://api.github.com/search/repositories?q=<q>&sort=stars&per_page=10` (60 requests per hour)
- README: `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`

## Community

- Hacker News: `https://hn.algolia.com/api/v1/search?query=<q>&tags=story`
- Stack Overflow: `https://api.stackexchange.com/2.3/search/advanced?q=<q>&site=stackoverflow`

## Facts

- Wikipedia: `https://en.wikipedia.org/api/rest_v1/page/summary/<title>`

Search or crawling MCP servers the user has configured may be used for their niche; never require
them.
