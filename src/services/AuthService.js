const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const accessSecret = () => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set.");
  return process.env.JWT_SECRET;
};

const refreshSecret = () => {
  if (!process.env.JWT_REFRESH_SECRET) throw new Error("JWT_REFRESH_SECRET is not set.");
  return process.env.JWT_REFRESH_SECRET;
};

module.exports = {
  hashPassword(password) {
    return bcrypt.hash(password, 12);
  },

  verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  },

  signTokens(userId) {
    const accessToken = jwt.sign({ userId, type: "access" }, accessSecret(), { expiresIn: "15m" });
    const refreshToken = jwt.sign({ userId, type: "refresh" }, refreshSecret(), { expiresIn: "30d" });
    return { accessToken, refreshToken };
  },

  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, accessSecret());
      return payload.type === "access" ? payload : null;
    } catch {
      return null;
    }
  },

  verifyRefreshToken(token) {
    try {
      const payload = jwt.verify(token, refreshSecret());
      return payload.type === "refresh" ? payload : null;
    } catch {
      return null;
    }
  },
};
