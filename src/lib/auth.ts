import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Email from "next-auth/providers/email";

import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/prisma";

if (!process.env.AUTH_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[auth] WARNING: AUTH_SECRET is not set in production. Using a fallback secret. Please set AUTH_SECRET in your environment variables."
    );
  }
  process.env.AUTH_SECRET = "fallback-production-secret-please-configure-auth-secret-env";
}

/**
 * Email magic-link provider using the Resend HTTP API directly (no nodemailer).
 * Enabled only when `AUTH_RESEND_KEY` is set, so a clone without it still boots
 * with just Google (or with no providers at all — browsing stays free).
 */
const emailProvider = process.env.AUTH_RESEND_KEY
  ? [
      Email({
        from: process.env.AUTH_EMAIL_FROM ?? "noreply@phonq.app",
        sendVerificationRequest: async ({ identifier, url, provider }) => {
          const apiKey = process.env.AUTH_RESEND_KEY;
          if (!apiKey) throw new Error("AUTH_RESEND_KEY is not set");
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: provider.from ?? process.env.AUTH_EMAIL_FROM,
              to: identifier,
              subject: "Your Phonq sign-in link",
              html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin-top:0">Sign in to Phonq</h2>
  <p>Click the button below to sign in. It expires in 24 hours and works once.</p>
  <p style="text-align:center;margin:32px 0">
    <a href="${url}" style="background:#9d67e9;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Sign in to Phonq</a>
  </p>
  <p style="color:#6b7280;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
</div>`,
              text: `Sign in to Phonq: ${url}`,
            }),
          });
          if (!res.ok) {
            throw new Error("Failed to send verification email");
          }
        },
      }),
    ]
  : [];

/**
 * Resilient wrapper around the Prisma adapter.
 *
 * The app's session strategy is JWT, so the database is only needed during the
 * sign-in handshake (OAuth account linking). When the DB is unreachable (paused
 * Neon, bad connection string, network blip) the raw adapter throws an
 * `AdapterError` and kills the whole callback with a 302->error page.
 *
 * This wrapper degrades the same way the catalog does: if a DB call fails, we
 * return "no account / no user" instead of throwing. Sign-in then completes as
 * a JWT-only session — the user is authenticated and can browse/stream, and the
 * moment the DB is reachable again account linking works normally.
 */
function resilientPrismaAdapter(): ReturnType<typeof PrismaAdapter> {
  const adapter = PrismaAdapter(prisma);

  /**
   * Wrap a possibly-undefined async adapter method so a DB failure returns a
   * benign value (null/undefined) instead of throwing an `AdapterError`.
   * Promise rejection and synchronous throw are both handled.
   */
  const safe = (fallback: unknown) => {
    return <A extends unknown[], R>(
      fn: ((...args: A) => R) | undefined,
    ) => {
      const wrapped = async (...args: A): Promise<unknown> => {
        if (!fn) return fallback;
        try {
          return await fn(...args);
        } catch {
          return fallback;
        }
      };
      return wrapped as (...args: A) => R;
    };
  };

  return {
    ...adapter,
    getUserByAccount: safe(null)(adapter.getUserByAccount),
    getUserByEmail: safe(null)(adapter.getUserByEmail),
    getUser: safe(null)(adapter.getUser),
    getSessionAndUser: safe(null)(adapter.getSessionAndUser),
    createUser: (async (user) => {
      if (!adapter.createUser) return user;
      try {
        return await adapter.createUser(user);
      } catch {
        return user;
      }
    }) as NonNullable<ReturnType<typeof PrismaAdapter>>["createUser"],
    updateUser: safe(null)(adapter.updateUser),
    deleteUser: safe(null)(adapter.deleteUser),
    linkAccount: safe(undefined)(adapter.linkAccount),
    unlinkAccount: safe(undefined)(adapter.unlinkAccount),
    createSession: safe(null)(adapter.createSession),
    updateSession: safe(null)(adapter.updateSession),
    deleteSession: safe(undefined)(adapter.deleteSession),
    createVerificationToken: safe(null)(adapter.createVerificationToken),
    useVerificationToken: safe(null)(adapter.useVerificationToken),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: resilientPrismaAdapter(),
  trustHost: true,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    Google({
      authorization: { params: { scope: "openid email profile" } },
    }),
    ...emailProvider,
  ],
  callbacks: {
    session: ({ session, token }) => {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
});
