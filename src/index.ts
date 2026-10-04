// RepoPilotAI application entry point.
import "./server.js";

/* Legacy in-memory prototype retained only as a comment while the database-backed server is used.
import Fastify, { type FastifyError } from "fastify";
import fastifyJwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

type User = {
	id: string;
	email: string;
	passwordHash: string;
};

type Workspace = {
	id: string;
	ownerId: string;
	name: string;
};

export function buildServer(jwtSecret = process.env.JWT_SECRET ?? "local-development-secret-change-me") {
	const server = Fastify({ logger: true });
	const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
	const users = new Map<string, User>();
	const workspaces = new Map<string, Workspace>();

	server.register(fastifyJwt, { secret: jwtSecret });

	server.setErrorHandler((error: FastifyError, _request, reply) => {
		if (error.validation) {
			return reply.status(400).send({
				error: {
					code: "VALIDATION_ERROR",
					message: "Request is invalid",
					details: error.validation,
				},
			});
		}

		return reply.send(error);
	});

	server.get("/v1/health", async () => {
		return { status: "ok" };
	});

	server.post<{ Body: { email: string; password: string } }>(
		"/v1/auth/register",
		{
			schema: {
				body: {
					type: "object",
					required: ["email", "password"],
					additionalProperties: false,
					properties: {
						email: { type: "string", format: "email", maxLength: 320 },
						password: { type: "string", minLength: 8, maxLength: 128 },
					},
				},
			},
		},
		async (request, reply) => {
			const email = request.body.email.toLowerCase();
			if (users.has(email)) {
				return reply.status(409).send({
					error: { code: "EMAIL_ALREADY_REGISTERED", message: "An account already exists" },
				});
			}

			const user: User = {
				id: randomUUID(),
				email,
				passwordHash: await bcrypt.hash(request.body.password, 12),
			};
			users.set(email, user);

			const accessToken = await reply.jwtSign({ sub: user.id, email: user.email }, { expiresIn: "15m" });
			return reply.status(201).send({ user: { id: user.id, email: user.email }, accessToken });
		},
	);

	const requireAuthentication = async (request: { jwtVerify: () => Promise<unknown> }, reply: { status: (statusCode: number) => { send: (payload: unknown) => unknown } }) => {
		try {
			await request.jwtVerify();
		} catch {
			return reply.status(401).send({
				error: { code: "UNAUTHORIZED", message: "A valid access token is required" },
			});
		}
	};

	server.post<{ Body: { name: string } }>(
		"/v1/workspaces",
		{
			preHandler: requireAuthentication,
			schema: {
				body: {
					type: "object",
					required: ["name"],
					additionalProperties: false,
					properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
				},
			},
		},
		async (request, reply) => {
			const user = request.user as { sub: string };
			const workspace: Workspace = { id: randomUUID(), ownerId: user.sub, name: request.body.name };
			workspaces.set(workspace.id, workspace);
			return reply.status(201).send({ workspace });
		},
	);

	server.post<{ Body: { email: string; password: string } }>(
		"/v1/auth/login",
		{
			schema: {
				body: {
					type: "object",
					required: ["email", "password"],
					additionalProperties: false,
					properties: {
						email: { type: "string", format: "email", maxLength: 320 },
						password: { type: "string", minLength: 8, maxLength: 128 },
					},
				},
			},
		},
		async (request, reply) => {
			const user = users.get(request.body.email.toLowerCase());
			if (!user || !(await bcrypt.compare(request.body.password, user.passwordHash))) {
				return reply.status(401).send({
					error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
				});
			}

			const accessToken = await reply.jwtSign({ sub: user.id, email: user.email }, { expiresIn: "15m" });
			return reply.send({ user: { id: user.id, email: user.email }, accessToken });
		},
	);

	server.post<{
		Params: { workspaceId: string };
		Body: { question: string; conversationId?: string };
	}>(
		"/v1/workspaces/:workspaceId/questions",
		{
			preHandler: requireAuthentication,
			schema: {
				params: {
					type: "object",
					required: ["workspaceId"],
					properties: { workspaceId: { type: "string", pattern: uuidPattern } },
				},
				body: {
					type: "object",
					required: ["question"],
					additionalProperties: false,
					properties: {
						question: { type: "string", minLength: 1, maxLength: 2000 },
						conversationId: { type: "string", pattern: uuidPattern },
					},
				},
			},
		},
		async (request, reply) => {
			const user = request.user as { sub: string };
			const workspace = workspaces.get(request.params.workspaceId);
			if (!workspace || workspace.ownerId !== user.sub) {
				return reply.status(404).send({
					error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found" },
				});
			}

			return reply.status(501).send({
				error: {
					code: "NOT_IMPLEMENTED",
					message: "Question answering is not implemented yet",
				},
			});
		},
	);

	return server;
}

const server = buildServer();
const port = Number(process.env.PORT ?? 3000);

server.listen({ port, host: "127.0.0.1" }).catch((error: unknown) => {
	server.log.error(error);
	process.exit(1);
});
*/
