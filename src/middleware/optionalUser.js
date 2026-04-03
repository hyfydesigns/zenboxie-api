/**
 * optionalUser — Like requireUser but never blocks the request.
 * If a valid Bearer token is present, attaches req.user.
 * If missing or invalid, continues silently with req.user = undefined.
 */

const AuthService = require("../services/AuthService");
const db = require("../db");

module.exports = async function optionalUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();

  const token = authHeader.slice(7);
  const payload = AuthService.verifyAccessToken(token);
  if (!payload) return next();

  const user = await db.user
    .findUnique({ where: { id: payload.userId }, include: { subscription: true } })
    .catch(() => null);

  if (user) req.user = user;
  next();
};
