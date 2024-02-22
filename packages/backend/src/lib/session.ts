import { Context } from "./context";
import { UnderscoreID } from "./mongo";
import { errors } from "./errors";
import { AuthenticatedContext } from "./middleware";
import { nanoid } from "nanoid";
import { ObjectId } from "mongodb";
import {
  BaseRoleType,
  FullRole,
  Permission,
  Workspace,
  WorkspaceMembership,
  getRolesCollection,
  getUserSettingsCollection,
  getWorkspaceMembershipsCollection,
  getWorkspacesCollection
} from "#collections";

declare module "node:net" {
  interface Socket {
    sessionId?: string;
  }
}

interface SessionData {
  workspaceId: string;
  userId: string;
  roleId: string;
  permissions: Permission[];
  baseType?: BaseRoleType;
  subscriptionStatus?: string;
  subscriptionPlan?: string;
}

const getSessionId = async (
  ctx: Context,
  tokenType: "accessToken" | "refreshToken" = "accessToken"
): Promise<string | null> => {
  if (ctx.req.socket && ctx.req.socket.sessionId) {
    return ctx.req.socket.sessionId;
  }

  try {
    const cookies = ctx.fastify.parseCookie(ctx.req.headers.cookie || "");

    if (!cookies[tokenType]) {
      return null;
    }

    const token = ctx.fastify.unsignCookie(cookies[tokenType] || "")?.value || "";

    if (!token) {
      return null;
    }

    const { sessionId } = ctx.fastify.jwt.verify<{ sessionId: string }>(token);

    if (tokenType === "refreshToken") {
      const allowed = await ctx.fastify.redis.exists(`refreshToken:${sessionId}`);

      if (!allowed) {
        return null;
      }
    }

    if (ctx.req.socket) {
      ctx.req.socket.sessionId = sessionId;
      // Fixes https://github.com/fastify/fastify-websocket/issues/74
      ctx.req.socket.on("data", () => {
        ctx.req.socket.resume();
      });
    }

    return sessionId;
  } catch (error) {
    return null;
  }
};
const loadSessionData = async (ctx: Context, userId: string): Promise<SessionData> => {
  const userSettingsCollection = getUserSettingsCollection(ctx.db);
  const workspacesCollection = getWorkspacesCollection(ctx.db);
  const workspaceMembershipsCollection = getWorkspaceMembershipsCollection(ctx.db);
  const rolesCollection = getRolesCollection(ctx.db);

  let role: UnderscoreID<FullRole<ObjectId>> | null = null;
  let workspaceMembership: UnderscoreID<WorkspaceMembership<ObjectId>> | null = null;
  let workspace: UnderscoreID<Workspace<ObjectId>> | null = null;

  try {
    const userSettings = await userSettingsCollection.findOne({
      userId: new ObjectId(userId)
    });

    if (!userSettings) throw errors.notFound("userSettings");

    workspaceMembership = await workspaceMembershipsCollection.findOne({
      userId: new ObjectId(userId),
      workspaceId: new ObjectId(userSettings.currentWorkspaceId)
    });
    workspace = await workspacesCollection.findOne({
      _id: new ObjectId(userSettings.currentWorkspaceId)
    });

    if (workspaceMembership) {
      role = await rolesCollection.findOne({
        _id: workspaceMembership.roleId
      });
    }
  } catch (error) {
    ctx.fastify.log.error(error);
  }

  return {
    workspaceId: workspace && workspaceMembership ? `${workspace?._id}` : "",
    subscriptionStatus: workspace?.subscriptionStatus,
    subscriptionPlan: workspace?.subscriptionPlan,
    userId: `${userId}`,
    roleId: `${role?._id || ""}`,
    permissions: role?.permissions || [],
    baseType: role?.baseType
  };
};
const createTokens = async (ctx: Context, sessionId: string): Promise<void> => {
  const accessToken = await ctx.res.jwtSign({ sessionId }, { sign: { expiresIn: 60 * 60 * 24 } });
  const refreshToken = await ctx.res.jwtSign(
    { sessionId },
    { sign: { expiresIn: 60 * 60 * 24 * 60 } }
  );
  const cookieOptions = {
    httpOnly: true,
    sameSite: true,
    signed: true,
    secure: new URL(ctx.fastify.config.PUBLIC_API_URL).protocol === "https:",
    domain: ctx.fastify.config.COOKIE_DOMAIN
  };

  await ctx.fastify.redis.set(`refreshToken:${sessionId}`, refreshToken, "EX", 60 * 60 * 24 * 60);
  ctx.res.setCookie("refreshToken", refreshToken, {
    ...cookieOptions,
    path: "/session",
    maxAge: 60 * 60 * 24 * 60
  });
  ctx.res.setCookie("accessToken", accessToken, {
    ...cookieOptions,
    path: "/",
    maxAge: 60 * 60 * 24
  });
};
const setSession = async (
  ctx: Context,
  sessionId: string,
  sessionData: SessionData
): Promise<void> => {
  await ctx.fastify.redis.set(
    `session:${sessionId}`,
    JSON.stringify(sessionData),
    "EX",
    60 * 60 * 24 * 60
  );
  await ctx.fastify.redis.sadd(`role:${sessionData.roleId}:sessions`, sessionId);
  await ctx.fastify.redis.sadd(`user:${sessionData.userId}:sessions`, sessionId);
  await ctx.fastify.redis.sadd(`workspace:${sessionData.workspaceId}:sessions`, sessionId);
  await ctx.fastify.redis.hset("session:role", sessionId, sessionData.roleId);
  await ctx.fastify.redis.hset("session:user", sessionId, sessionData.userId);
  await ctx.fastify.redis.hset("session:workspace", sessionId, sessionData.workspaceId);
};
const createSession = async (ctx: Context, userId: string): Promise<void> => {
  const sessionId = nanoid();
  const sessionData = await loadSessionData(ctx, userId);

  await setSession(ctx, sessionId, sessionData);
  await createTokens(ctx, sessionId);
};
const refreshSession = async (ctx: Context, sessionId: string): Promise<void> => {
  const sessionCache = await ctx.fastify.redis.get(`session:${sessionId}`);

  await ctx.fastify.redis.del(`refreshToken:${sessionId}`);

  if (sessionCache) {
    await ctx.fastify.redis.expire(`session:${sessionId}`, 60 * 60 * 24 * 60);
    await createTokens(ctx, sessionId);
  }
};
const updateSession = async (ctx: Context, sessionId: string, userId: string): Promise<void> => {
  const sessionCache = await ctx.fastify.redis.get(`session:${sessionId}`);

  if (sessionCache) {
    const sessionData = await loadSessionData(ctx, userId);

    await setSession(ctx, sessionId, sessionData);
  }
};
const updateSessionRole = async (ctx: Context, roleId: string): Promise<void> => {
  const sessionIds = await ctx.fastify.redis.smembers(`role:${roleId}:sessions`);

  for await (const sessionId of sessionIds) {
    const userId = await ctx.fastify.redis.hget("session:user", sessionId);

    if (userId) {
      await updateSession(ctx, sessionId, userId);
    }
  }
};
const updateSessionUser = async (ctx: Context, userId: string): Promise<void> => {
  const sessionIds = await ctx.fastify.redis.smembers(`user:${userId}:sessions`);

  for await (const sessionId of sessionIds) {
    await updateSession(ctx, sessionId, userId);
  }
};
const updateSessionWorkspace = async (ctx: Context, workspaceId: string): Promise<void> => {
  const sessionIds = await ctx.fastify.redis.smembers(`workspace:${workspaceId}:sessions`);

  for await (const sessionId of sessionIds) {
    const userId = await ctx.fastify.redis.hget("session:user", sessionId);

    if (userId) {
      await updateSession(ctx, sessionId, userId);
    }
  }
};
const switchWorkspaceSession = async (ctx: AuthenticatedContext): Promise<void> => {
  const sessionId = await getSessionId(ctx, "accessToken");

  if (!sessionId) return;

  const sessionCache = await ctx.fastify.redis.get(`session:${sessionId}`);

  if (sessionCache) {
    const sessionData = JSON.parse(sessionCache) as SessionData;

    await ctx.fastify.redis.srem(`role:${sessionData.roleId}:sessions`, sessionId);
    await ctx.fastify.redis.srem(`user:${sessionData.userId}:sessions`, sessionId);
    await ctx.fastify.redis.srem(`workspace:${sessionData.workspaceId}:sessions`, sessionId);
  }

  await ctx.fastify.redis.hdel("session:role", sessionId);
  await ctx.fastify.redis.hdel("session:user", sessionId);
  await ctx.fastify.redis.hdel("session:workspace", sessionId);
  await updateSession(ctx, sessionId, `${ctx.auth.userId}`);
};
const deleteSession = async (ctx: Context, sessionId: string): Promise<void> => {
  const sessionCache = await ctx.fastify.redis.get(`session:${sessionId}`);

  if (sessionCache) {
    const sessionData = JSON.parse(sessionCache) as SessionData;

    await ctx.fastify.redis.del(`session:${sessionId}`);
    await ctx.fastify.redis.srem(`role:${sessionData.roleId}:sessions`, sessionId);
    await ctx.fastify.redis.srem(`user:${sessionData.userId}:sessions`, sessionId);
    await ctx.fastify.redis.srem(`workspace:${sessionData.workspaceId}:sessions`, sessionId);
  }

  await ctx.fastify.redis.hdel("session:role", sessionId);
  await ctx.fastify.redis.hdel("session:user", sessionId);
  await ctx.fastify.redis.hdel("session:workspace", sessionId);
  await ctx.fastify.redis.del(`refreshToken:${sessionId}`);
  ctx.res.clearCookie("refreshToken", {
    path: "/session",
    domain: ctx.fastify.config.COOKIE_DOMAIN
  });
  ctx.res.clearCookie("accessToken", {
    path: "/",
    domain: ctx.fastify.config.COOKIE_DOMAIN
  });
};

export {
  getSessionId,
  createSession,
  refreshSession,
  updateSession,
  deleteSession,
  updateSessionRole,
  updateSessionUser,
  updateSessionWorkspace,
  switchWorkspaceSession
};
export type { SessionData };
