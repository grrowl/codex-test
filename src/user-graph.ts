export class UserGraph {
  state: DurableObjectState
  env: Env
  kuzu: any | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async ensureDB() {
    if (this.kuzu) return;
    const { default: kuzu } = await import('kuzu');
    const dbPath = await this.state.storage.get<string>('dbPath');
    if (!dbPath) {
      // create a new db within durable object storage
      const path = `/tmp/${this.state.id.toString()}.kuzu`; // ephemeral path
      this.kuzu = new kuzu.Database(path);
      await this.state.storage.put('dbPath', path);
    } else {
      this.kuzu = new kuzu.Database(dbPath);
    }
  }

  async loadRepo(token: string, repo: string) {
    await this.ensureDB();
    // placeholder: just store repo info
    await this.state.storage.put('repo', { token, repo });
  }

  async query(cypher: string) {
    await this.ensureDB();
    // placeholder query execution
    const result = this.kuzu.query(cypher);
    return result.toArray();
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/load') {
      const body = await request.json() as { token: string; repo: string };
      await this.loadRepo(body.token, body.repo);
      return new Response('ok');
    }
    if (url.pathname === '/query') {
      const body = await request.json() as { cypher: string };
      const res = await this.query(body.cypher);
      return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' }});
    }
    return new Response('not found', { status: 404 });
  }
}
