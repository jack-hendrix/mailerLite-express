const dotenv = require("dotenv");
const MailerLite = require("@mailerlite/mailerlite-nodejs").default;
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const { rateLimit } = require("express-rate-limit");

dotenv.config();

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

function readConfig(env) {
  return {
    port: env.PORT || 3000,
    mailerliteApiKey: env.MAILERLITE_API_KEY,
    groupId: env.GROUP_ID,
    imgurClientId: env.IMGUR_CLIENT_ID,
    firebaseProjectId: env.FIREBASE_PROJECT_ID,
    adminUid: env.ADMIN_UID,
    allowedOrigins: (env.ALLOWED_ORIGINS || "http://localhost:4200")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

// Verifies a Firebase Auth ID token the way the Firebase docs describe for
// third-party JWT libraries: RS256, signed by Google's securetoken keys,
// issued for this project, and with a subject and past auth_time.
// `keySet` is only overridden by tests.
function createFirebaseTokenVerifier(projectId, keySet) {
  let jwks = keySet;
  return async (token) => {
    // jose is ESM-only; a dynamic import works from CommonJS on any Node.
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    jwks ??= createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new Error("Token has no subject");
    }
    if (
      typeof payload.auth_time !== "number" ||
      payload.auth_time > Date.now() / 1000
    ) {
      throw new Error("Token has an invalid auth_time");
    }
    return payload;
  };
}

function createImgurUploader(clientId) {
  return async (imageBuffer) => {
    const imgurResponse = await axios.post(
      "https://api.imgur.com/3/image",
      imageBuffer,
      {
        headers: {
          Authorization: `Client-ID ${clientId}`,
          "Content-Type": "application/octet-stream",
        },
        timeout: 30000,
      }
    );
    return imgurResponse.data.success ? imgurResponse.data.data.link : null;
  };
}

function createApp({ config, mailerlite, uploadImage, verifyToken }) {
  const app = express();

  // nginx on the same host proxies /api here, so only trust it for client IPs.
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");

  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json({ limit: "10kb" }));

  const subscribeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
  });

  async function requireAdmin(req, res, next) {
    if (!config.firebaseProjectId || !config.adminUid) {
      console.error("FIREBASE_PROJECT_ID and ADMIN_UID must be set");
      return res.status(503).json({ error: "Uploads are not configured" });
    }
    const match = /^Bearer (\S+)$/.exec(req.get("Authorization") || "");
    if (!match) {
      return res.status(401).json({ error: "Missing token" });
    }
    try {
      const payload = await verifyToken(match[1]);
      if (payload.sub !== config.adminUid) {
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    } catch (error) {
      console.error("Rejected upload token:", error.code || error.message);
      res.status(401).json({ error: "Invalid token" });
    }
  }

  app.post("/api/subscriber", subscribeLimiter, async (req, res) => {
    const email = req.body?.email;
    if (
      typeof email !== "string" ||
      email.length > MAX_EMAIL_LENGTH ||
      !EMAIL_PATTERN.test(email)
    ) {
      return res.status(400).json({ error: "A valid email is required" });
    }

    try {
      const response = await mailerlite.subscribers.createOrUpdate({ email });
      const subscriberId = response.data.data.id;
      await mailerlite.groups.assignSubscriber(subscriberId, config.groupId);
      // Only confirm success; the MailerLite response holds subscriber data.
      res.status(200).json({ success: true });
    } catch (error) {
      console.error(
        "Error adding subscriber:",
        error.response?.data || error.message
      );
      const status = error.response?.status;
      res
        .status(status >= 400 && status < 500 ? status : 500)
        .json({ error: "Error occurred" });
    }
  });

  // Authenticate before multer so anonymous uploads are never buffered.
  app.post(
    "/api/upload-image",
    uploadLimiter,
    requireAdmin,
    upload.single("image"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "No image uploaded" });
      }

      try {
        const imageUrl = await uploadImage(req.file.buffer);
        if (!imageUrl) {
          return res
            .status(502)
            .json({ error: "Failed to upload image to Imgur" });
        }
        res.json({
          success: true,
          message: "Form submitted successfully!",
          imageUrl,
        });
      } catch (error) {
        console.error(
          "Error uploading image:",
          error.response?.data || error.message
        );
        res.status(500).json({ error: "Server error" });
      }
    }
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: "Bad request" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  });

  return app;
}

module.exports = { createApp, readConfig, createFirebaseTokenVerifier };

if (require.main === module) {
  const config = readConfig(process.env);
  if (!config.firebaseProjectId || !config.adminUid) {
    console.warn(
      "FIREBASE_PROJECT_ID and ADMIN_UID are not set; image uploads are disabled."
    );
  }
  const app = createApp({
    config,
    mailerlite: new MailerLite({ api_key: config.mailerliteApiKey }),
    uploadImage: createImgurUploader(config.imgurClientId),
    verifyToken: createFirebaseTokenVerifier(config.firebaseProjectId),
  });
  app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
  });
}
