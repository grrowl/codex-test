# Plan: GitHub Auth Durable Object Graph Server

This plan outlines how to extend the current MCP GitHub OAuth server with durable graph analysis capabilities.

## 1. Authentication
- Reuse the existing GitHub OAuth handler.
- When a tool is invoked, extract the authenticated user's login from `this.props`.
- Use `env.DURABLE_OBJECT.idFromName(this.props.login)` to obtain the durable object for the user.

## 2. Durable Object Responsibilities
- On first use, create an SQLite database inside the durable object's storage.
- Attach the database to a Kùzu instance using the [SQLite extension](https://docs.kuzudb.com/extensions/attach/sqlite/).
- Store the parsed graph of the user's GitHub repository in this database.

## 3. Repository Import
- Use the authenticated `Octokit` instance with `this.props.accessToken` to fetch source files from the repository.
- Parse the TypeScript project using the TypeScript Compiler API and extract entities.
- Insert nodes and edges into Kùzu to represent files, classes, functions and their relationships.

## 4. MCP Tools
- `loadRepo`: clones or fetches the repository and populates the graph in the durable object.
- `cypherQuery`: accepts a Cypher statement and returns query results from Kùzu.

## 5. Lazy Initialization
- Each tool call checks for the user's durable object.
- If the graph is not yet built, `loadRepo` runs automatically before executing queries.

This approach keeps per-user data isolated in separate durable objects while enabling powerful graph queries over imported GitHub code.
