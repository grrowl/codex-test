import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Octokit } from "octokit";
import { GitHubHandler } from "./github-handler";
import { UserGraph } from "./user-graph";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

const ALLOWED_USERNAMES = new Set<string>([
  // Add GitHub usernames of users who should have access to the image generation tool
  // For example: 'yourusername', 'coworkerusername'
]);

export class MyMCP extends McpAgent<Env, {}, Props> {
  server = new McpServer({
    name: "Github OAuth Proxy Demo",
    version: "1.0.0",
  });

  async init() {
    // Hello, world!
    this.server.tool("add", "Add two numbers the way only MCP can", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));

    // Use the upstream access token to facilitate tools
    this.server.tool("userInfoOctokit", "Get user info from GitHub, via Octokit", {}, async () => {
      const octokit = new Octokit({ auth: this.props.accessToken });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(await octokit.rest.users.getAuthenticated()),
          },
        ],
      };
    });

    const getGraph = () => {
      const id = this.env.USER_GRAPH.idFromName(this.props.login);
      return this.env.USER_GRAPH.get(id);
    };

    this.server.tool(
      "loadRepo",
      "Load a GitHub repository into the graph",
      { repo: z.string() },
      async ({ repo }) => {
        const stub = getGraph();
        await stub.fetch("/load", {
          method: "POST",
          body: JSON.stringify({ token: this.props.accessToken, repo }),
        });
        return { content: [{ type: "text", text: "loaded" }] };
      },
    );

    this.server.tool(
      "cypherQuery",
      "Run a Cypher query over the imported repository",
      { query: z.string() },
      async ({ query }) => {
        const stub = getGraph();
        const res = await stub.fetch("/query", {
          method: "POST",
          body: JSON.stringify({ cypher: query }),
        });
        return { content: [{ type: "text", text: await res.text() }] };
      },
    );

    // Dynamically add tools based on the user's login. In this case, I want to limit
    // access to my Image Generation tool to just me
    if (ALLOWED_USERNAMES.has(this.props.login)) {
      this.server.tool(
        "generateImage",
        "Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
        {
          prompt: z.string().describe("A text description of the image you want to generate."),
          steps: z
            .number()
            .min(4)
            .max(8)
            .default(4)
            .describe(
              "The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive.",
            ),
        },
        async ({ prompt, steps }) => {
          const response = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
            prompt,
            steps,
          });

          return {
            content: [{ type: "image", data: response.image!, mimeType: "image/jpeg" }],
          };
        },
      );
    }
  }
}

export default new OAuthProvider({
  apiRoute: "/sse",
  apiHandler: MyMCP.mount("/sse") as any,
  defaultHandler: GitHubHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
