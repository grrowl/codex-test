import { Octokit } from 'octokit'
import * as ts from 'typescript'
import { Buffer } from 'buffer'
import * as path from 'path'

export class UserGraph {
  state: DurableObjectState
  env: Env
  kuzu: any | null = null
  conn: any | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async ensureDB() {
    if (this.kuzu) return;
    const { default: kuzu } = await import('kuzu');
    let dbPath = await this.state.storage.get<string>('dbPath');
    if (!dbPath) {
      dbPath = `/tmp/${this.state.id.toString()}.kuzu`;
      this.kuzu = new kuzu.Database(dbPath);
      this.conn = new kuzu.Connection(this.kuzu);
      await this.conn.init();
      await this.initSchema();
      await this.state.storage.put('dbPath', dbPath);
    } else {
      this.kuzu = new kuzu.Database(dbPath);
      this.conn = new kuzu.Connection(this.kuzu);
      await this.conn.init();
    }
  }

  async initSchema() {
    await this.conn!.query(
      'CREATE NODE TABLE IF NOT EXISTS File(path STRING, PRIMARY KEY(path));',
    );
    await this.conn!.query(
      'CREATE NODE TABLE IF NOT EXISTS Class(name STRING, PRIMARY KEY(name));',
    );
    await this.conn!.query(
      'CREATE NODE TABLE IF NOT EXISTS Function(name STRING, PRIMARY KEY(name));',
    );
    await this.conn!.query(
      'CREATE NODE TABLE IF NOT EXISTS Variable(name STRING, PRIMARY KEY(name));',
    );
    await this.conn!.query(
      'CREATE REL TABLE IF NOT EXISTS FileDeclaresClass(FROM File TO Class);',
    );
    await this.conn!.query(
      'CREATE REL TABLE IF NOT EXISTS FileDeclaresFunction(FROM File TO Function);',
    );
    await this.conn!.query(
      'CREATE REL TABLE IF NOT EXISTS FileDeclaresVariable(FROM File TO Variable);',
    );
    await this.conn!.query(
      'CREATE REL TABLE IF NOT EXISTS FileImportsClass(FROM File TO Class);',
    );
    await this.conn!.query(
      'CREATE REL TABLE IF NOT EXISTS FileImportsFunction(FROM File TO Function);',
    );
    await this.conn!.query(
      'CREATE REL TABLE IF NOT EXISTS FileImportsVariable(FROM File TO Variable);',
    );
  }

  parseFile(src: string) {
    const sf = ts.createSourceFile('tmp.ts', src, ts.ScriptTarget.Latest, true);
    const classes: string[] = [];
    const functions: string[] = [];
    const variables: string[] = [];
    const imports: { name: string; from: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        classes.push(node.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        functions.push(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) variables.push(d.name.text);
        }
      }
      if (ts.isImportDeclaration(node)) {
        const mod = (node.moduleSpecifier as ts.StringLiteral).text;
        if (node.importClause) {
          if (node.importClause.name) {
            imports.push({ name: node.importClause.name.text, from: mod });
          }
          const named = node.importClause.namedBindings;
          if (named) {
            if (ts.isNamespaceImport(named)) {
              imports.push({ name: named.name.text + '.*', from: mod });
            } else if (ts.isNamedImports(named)) {
              for (const el of named.elements) {
                imports.push({ name: el.name.text, from: mod });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return { classes, functions, variables, imports };
  }

  async loadRepo(token: string, repo: string) {
    await this.ensureDB();
    const octokit = new Octokit({ auth: token });
    const [owner, name] = repo.split('/');

    const treeRes = await octokit.rest.git.getTree({
      owner,
      repo: name,
      tree_sha: 'HEAD',
      recursive: 'true',
    });

    const files = treeRes.data.tree.filter(
      (t: any) => t.type === 'blob' && (t.path.endsWith('.ts') || t.path.endsWith('.tsx')),
    );

    const parsed: Record<string, { classes: string[]; functions: string[]; variables: string[]; imports: { name: string; from: string }[] }> = {};

    for (const file of files) {
      const blob = await octokit.rest.git.getBlob({ owner, repo: name, file_sha: file.sha });
      const content = Buffer.from(blob.data.content, 'base64').toString();
      parsed[file.path] = this.parseFile(content);
    }

    for (const [fp, data] of Object.entries(parsed)) {
      const filePath = fp.replace(/'/g, "''");
      await this.conn!.query(`CREATE (:File {path: '${filePath}'});`);
      for (const cls of data.classes) {
        const clsEsc = cls.replace(/'/g, "''");
        await this.conn!.query(
          `MATCH(f:File {path:'${filePath}'}) CREATE (f)-[:FileDeclaresClass]->(:Class {name:'${clsEsc}'});`,
        );
      }
      for (const fn of data.functions) {
        const fnEsc = fn.replace(/'/g, "''");
        await this.conn!.query(
          `MATCH(f:File {path:'${filePath}'}) CREATE (f)-[:FileDeclaresFunction]->(:Function {name:'${fnEsc}'});`,
        );
      }
      for (const v of data.variables) {
        const vEsc = v.replace(/'/g, "''");
        await this.conn!.query(
          `MATCH(f:File {path:'${filePath}'}) CREATE (f)-[:FileDeclaresVariable]->(:Variable {name:'${vEsc}'});`,
        );
      }
    }

    for (const [fp, data] of Object.entries(parsed)) {
      const filePath = fp.replace(/'/g, "''");
      for (const im of data.imports) {
        const nameEsc = im.name.replace(/'/g, "''");
        await this.conn!.query(
          `MATCH(f:File {path:'${filePath}'}), (c:Class {name:'${nameEsc}'}) CREATE (f)-[:FileImportsClass]->(c);`,
        );
        await this.conn!.query(
          `MATCH(f:File {path:'${filePath}'}), (fn:Function {name:'${nameEsc}'}) CREATE (f)-[:FileImportsFunction]->(fn);`,
        );
        await this.conn!.query(
          `MATCH(f:File {path:'${filePath}'}), (v:Variable {name:'${nameEsc}'}) CREATE (f)-[:FileImportsVariable]->(v);`,
        );
      }
    }

    await this.state.storage.put('repo', { token, repo });
  }

  async query(cypher: string) {
    await this.ensureDB();
    const result = await this.conn!.query(cypher);
    const r = Array.isArray(result) ? result[0] : result;
    return r.getAll();
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
